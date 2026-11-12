package coordinator

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"golang.org/x/crypto/scrypt"
)

// LANIdentity is secret material. It belongs only in the supervising parent's
// encrypted profile and the private startup pipe, never a Raft entry or log.
type LANIdentity struct {
	CACertPEM string `json:"caCertPEM"`
	CAKeyPEM  string `json:"caKeyPEM"`
	CertPEM   string `json:"certPEM"`
	KeyPEM    string `json:"keyPEM"`
}

type PasswordVerifier struct {
	Salt string `json:"salt"`
	Key  string `json:"key"`
}

type PeerHint struct {
	DeviceID     string `json:"deviceId"`
	ControlURL   string `json:"controlUrl"`
	RaftEndpoint string `json:"raftEndpoint"`
}

type JoinInvitation struct {
	ControlURL       string `json:"controlUrl"`
	DeviceID         string `json:"deviceId"`
	TrustedCACertPEM string `json:"trustedCaCertPEM"`
	Password         string `json:"password"`
	RequestID        string `json:"requestId"`
}

type LANConfig struct {
	Version          int              `json:"version"`
	WorkspaceID      string           `json:"workspaceId"`
	Identity         LANIdentity      `json:"identity"`
	PasswordVerifier PasswordVerifier `json:"passwordVerifier"`
	ListenHost       string           `json:"listenHost"`
	ControlPort      int              `json:"controlPort"`
	RaftPort         int              `json:"raftPort"`
	PeerHints        []PeerHint       `json:"peerHints"`
	Join             *JoinInvitation  `json:"join,omitempty"`
}

var lanIdentifier = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func logicalName(workspaceID, deviceID string) string {
	return deviceID + "." + workspaceID + ".agent-pr-monitor.invalid"
}

func randomSerial() *big.Int {
	value, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	return value
}

// Leaves live one year; a saved workspace reissues its own once this little remains.
const leafRenewalWindow = 30 * 24 * time.Hour

func leafTemplate(workspaceID, deviceID string, now time.Time) *x509.Certificate {
	return &x509.Certificate{SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: logicalName(workspaceID, deviceID)}, DNSNames: []string{logicalName(workspaceID, deviceID)}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}}
}

func encodePEM(kind string, data []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: data}))
}

func GenerateLANIdentity(workspaceID, deviceID string) (LANIdentity, error) {
	return generateLANIdentity(workspaceID, deviceID, time.Now())
}

func generateLANIdentity(workspaceID, deviceID string, now time.Time) (LANIdentity, error) {
	if !lanIdentifier.MatchString(workspaceID) || !lanIdentifier.MatchString(deviceID) {
		return LANIdentity{}, errors.New("workspace and device IDs must be bounded lowercase DNS labels")
	}
	caPublic, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return LANIdentity{}, errors.New("cannot generate device identity")
	}
	ca := &x509.Certificate{SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: logicalName(workspaceID, deviceID)}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, MaxPathLen: 0, MaxPathLenZero: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, caPublic, caPrivate)
	if err != nil {
		return LANIdentity{}, errors.New("cannot create device certificate authority")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return LANIdentity{}, errors.New("cannot generate device certificate")
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate(workspaceID, deviceID, now), ca, public, caPrivate)
	if err != nil {
		return LANIdentity{}, errors.New("cannot create device certificate")
	}
	caKey, _ := x509.MarshalPKCS8PrivateKey(caPrivate)
	leafKey, _ := x509.MarshalPKCS8PrivateKey(private)
	return LANIdentity{CACertPEM: encodePEM("CERTIFICATE", caDER), CAKeyPEM: encodePEM("PRIVATE KEY", caKey), CertPEM: encodePEM("CERTIFICATE", leafDER), KeyPEM: encodePEM("PRIVATE KEY", leafKey)}, nil
}

// storedIdentity checks everything startup validation does except validity
// dates, so an expired leaf can be recognized as this device's own.
func storedIdentity(identity LANIdentity, workspaceID, deviceID string) (*x509.Certificate, crypto.PrivateKey, *x509.Certificate, error) {
	if !lanIdentifier.MatchString(workspaceID) || !lanIdentifier.MatchString(deviceID) {
		return nil, nil, nil, errors.New("workspace and device IDs must be bounded lowercase DNS labels")
	}
	ca, err := parseCA(identity.CACertPEM, workspaceID, deviceID)
	if err != nil {
		return nil, nil, nil, err
	}
	caPair, err := tls.X509KeyPair([]byte(identity.CACertPEM), []byte(identity.CAKeyPEM))
	if err != nil || len(caPair.Certificate) != 1 {
		return nil, nil, nil, errors.New("device authority private key does not match")
	}
	pair, err := tls.X509KeyPair([]byte(identity.CertPEM), []byte(identity.KeyPEM))
	if err != nil || len(pair.Certificate) != 1 {
		return nil, nil, nil, errors.New("device leaf private key does not match")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || leaf.IsCA || len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != logicalName(workspaceID, deviceID) || leaf.CheckSignatureFrom(ca) != nil {
		return nil, nil, nil, errors.New("invalid device leaf identity")
	}
	return ca, caPair.PrivateKey, leaf, nil
}

// reissueLANLeaf signs a new certificate for the existing leaf key with the
// stored device authority. Peers and saved Raft state pin only that authority,
// so the authority, its fingerprint and both keys stay exactly as they were.
func reissueLANLeaf(identity LANIdentity, workspaceID, deviceID string, now time.Time) (LANIdentity, error) {
	ca, authority, leaf, err := storedIdentity(identity, workspaceID, deviceID)
	if err != nil {
		return LANIdentity{}, err
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate(workspaceID, deviceID, now), ca, leaf.PublicKey, authority)
	if err != nil {
		return LANIdentity{}, errors.New("cannot create device certificate")
	}
	identity.CertPEM = encodePEM("CERTIFICATE", leafDER)
	return identity, nil
}

// RenewLANIdentity returns the identity unchanged unless its leaf has expired or
// is about to, in which case only the leaf certificate is reissued.
func RenewLANIdentity(identity LANIdentity, workspaceID, deviceID string) (LANIdentity, error) {
	return renewLANIdentity(identity, workspaceID, deviceID, time.Now())
}

func renewLANIdentity(identity LANIdentity, workspaceID, deviceID string, now time.Time) (LANIdentity, error) {
	ca, _, leaf, err := storedIdentity(identity, workspaceID, deviceID)
	if err != nil {
		return LANIdentity{}, err
	}
	if now.Before(ca.NotBefore) || now.After(ca.NotAfter) {
		return LANIdentity{}, errors.New("device authority is outside its validity period")
	}
	if now.Before(leaf.NotAfter.Add(-leafRenewalWindow)) {
		return identity, nil
	}
	return reissueLANLeaf(identity, workspaceID, deviceID, now)
}

func parseCA(encoded, workspaceID, deviceID string) (*x509.Certificate, error) {
	block, rest := pem.Decode([]byte(encoded))
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		return nil, errors.New("one PEM CA certificate is required")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !ca.IsCA || !ca.BasicConstraintsValid || !ca.MaxPathLenZero || ca.MaxPathLen != 0 || ca.Subject.CommonName != logicalName(workspaceID, deviceID) || ca.CheckSignatureFrom(ca) != nil {
		return nil, errors.New("invalid workspace-scoped device authority")
	}
	return ca, nil
}

func DecodeLANConfig(data []byte) (LANConfig, error) {
	var config LANConfig
	if len(data) > 64*1024 || decodeStrict(data, &config) != nil {
		return config, errors.New("invalid private LAN startup configuration")
	}
	return config, nil
}

func DecodeLANIdentity(data []byte) (LANIdentity, error) {
	var identity LANIdentity
	if len(data) > 64*1024 || decodeStrict(data, &identity) != nil {
		return LANIdentity{}, errors.New("invalid private LAN identity")
	}
	return identity, nil
}

func validateIdentity(identity LANIdentity, workspaceID, deviceID string) (tls.Certificate, *x509.Certificate, error) {
	ca, err := parseCA(identity.CACertPEM, workspaceID, deviceID)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	caPair, err := tls.X509KeyPair([]byte(identity.CACertPEM), []byte(identity.CAKeyPEM))
	if err != nil || len(caPair.Certificate) != 1 {
		return tls.Certificate{}, nil, errors.New("device authority private key does not match")
	}
	pair, err := tls.X509KeyPair([]byte(identity.CertPEM), []byte(identity.KeyPEM))
	if err != nil || len(pair.Certificate) != 1 {
		return tls.Certificate{}, nil, errors.New("device leaf private key does not match")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || leaf.IsCA || len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != logicalName(workspaceID, deviceID) {
		return tls.Certificate{}, nil, errors.New("invalid device leaf identity")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth} {
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: logicalName(workspaceID, deviceID), KeyUsages: []x509.ExtKeyUsage{usage}}); err != nil {
			return tls.Certificate{}, nil, errors.New("device certificate verification failed")
		}
	}
	pair.Leaf = leaf
	pair.Certificate = append(pair.Certificate, ca.Raw)
	return pair, ca, nil
}

func caFingerprint(ca *x509.Certificate) string {
	digest := sha256.Sum256(ca.Raw)
	return hex.EncodeToString(digest[:])
}

func NewPasswordVerifier(password string) (PasswordVerifier, error) {
	if len(password) < 8 || len(password) > 1024 {
		return PasswordVerifier{}, errors.New("workspace password must contain 8–1024 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return PasswordVerifier{}, errors.New("cannot create password salt")
	}
	key, err := scrypt.Key([]byte(password), salt, 16384, 8, 1, 32)
	if err != nil {
		return PasswordVerifier{}, errors.New("cannot derive password verifier")
	}
	return PasswordVerifier{Salt: base64.RawURLEncoding.EncodeToString(salt), Key: base64.RawURLEncoding.EncodeToString(key)}, nil
}

func (verifier PasswordVerifier) valid() bool {
	salt, a := base64.RawURLEncoding.DecodeString(verifier.Salt)
	key, b := base64.RawURLEncoding.DecodeString(verifier.Key)
	return a == nil && b == nil && len(salt) == 16 && len(key) == 32
}

func (verifier PasswordVerifier) matches(password string) bool {
	if !verifier.valid() || len(password) < 8 || len(password) > 1024 {
		return false
	}
	salt, _ := base64.RawURLEncoding.DecodeString(verifier.Salt)
	expected, _ := base64.RawURLEncoding.DecodeString(verifier.Key)
	actual, err := scrypt.Key([]byte(password), salt, 16384, 8, 1, 32)
	return err == nil && subtle.ConstantTimeCompare(actual, expected) == 1
}

func validateEndpoint(endpoint string) error {
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil {
		return errors.New("peer endpoint requires a numeric LAN address and port")
	}
	ip := net.ParseIP(host)
	number, parseErr := strconv.Atoi(port)
	if ip == nil || !(ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()) || parseErr != nil || number < 1 || number > 65535 {
		return errors.New("peer endpoint must be a unicast numeric LAN address")
	}
	return nil
}

func validateHint(hint PeerHint) error {
	parsed, err := url.Parse(hint.ControlURL)
	if !lanIdentifier.MatchString(hint.DeviceID) || len(hint.ControlURL) > 256 || err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" || validateEndpoint(parsed.Host) != nil || validateEndpoint(hint.RaftEndpoint) != nil {
		return errors.New("invalid public peer endpoint hint")
	}
	return nil
}
