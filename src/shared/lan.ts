export interface LanIdentity {
  caCertPEM: string
  caKeyPEM: string
  certPEM: string
  keyPEM: string
}

export interface PeerHint {
  deviceId: string
  controlUrl: string
  raftEndpoint: string
}

export interface LanConfig {
  version: 1
  workspaceId: string
  identity: LanIdentity
  passwordVerifier: { salt: string; key: string }
  listenHost: string
  controlPort: number
  raftPort: number
  peerHints: PeerHint[]
  join?: {
    controlUrl: string
    deviceId: string
    trustedCaCertPEM: string
    password: string
    requestId: string
  }
}

export interface WorkspaceProfile {
  id: string
  name: string
  deviceId: string
  creator: boolean
  repositoryRoot?: string
  enrollment?: { requestId: string; invitation: LanPublic }
  config: Omit<LanConfig, 'join'>
}

export interface WorkspaceProfileInfo {
  id: string
  name: string
  workspaceId: string
  deviceId: string
  enrollment?: { requestId: string; invitation: LanPublic }
}

export interface LanPublic extends PeerHint {
  workspaceId: string
  caCertPEM: string
  fingerprint: string
}

export interface LanStatus {
  workspaceId: string
  deviceId: string
  stage: 'starting' | 'pending' | 'nonvoter' | 'active'
  joinAttempt: 'none' | 'pending' | 'verified' | 'failed'
  hasAuthority: boolean
  leaderId: string
  members: Array<{ deviceId: string; caCertPEM: string; stage: string; joinRequestId?: string }>
  public: LanPublic
  joinError?: { code: string; message: string }
}

export interface WorkspacePoolView {
  profiles: WorkspaceProfileInfo[]
  interfaces: Array<{ name: string; address: string }>
  current: { id: string; name: string; mode: 'local' | 'lan' }
  lan: LanStatus | null
  error?: string
}

export interface WorkspacePoolApi {
  snapshot(): Promise<WorkspacePoolView>
  inspectInvitation(invitation: string): Promise<LanPublic>
  create(input: { name: string; password: string; listenHost: string }): Promise<WorkspacePoolView>
  join(input: { name: string; password: string; listenHost: string; invitation: string; fingerprintConfirmed: boolean }): Promise<WorkspacePoolView>
  open(input: { id: string; listenHost: string }): Promise<WorkspacePoolView>
  retryJoin(input: { id: string; password: string; listenHost: string; fingerprintConfirmed: boolean }): Promise<WorkspacePoolView>
}
