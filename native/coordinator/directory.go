package coordinator

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// prepareDataDirectory never changes permissions on a root/home directory or a
// final symlink. Existing app data must belong to this user before chmod or any
// database/snapshot open. Canonical comparison also catches ancestor aliases to
// the user's home. System aliases such as macOS /var -> /private/var are fine.
func prepareDataDirectory(directory string) (string, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", errors.New("invalid coordinator data directory")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.New("cannot identify the user's home directory")
	}
	if isUnsafeDataRoot(absolute, home) {
		return "", errors.New("data must use an app-specific directory, not a root or home directory")
	}
	if err := os.MkdirAll(absolute, 0700); err != nil {
		return "", errors.New("cannot create coordinator data directory")
	}
	metadata, err := os.Lstat(absolute)
	if err != nil || validateOwnedDirectory(metadata, os.Getuid()) != nil {
		return "", errors.New("coordinator data directory must be a user-owned directory, not a symlink")
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil || isUnsafeDataRoot(canonical, home) {
		return "", errors.New("coordinator data directory resolves to an unsafe root")
	}
	if err := os.Chmod(absolute, 0700); err != nil {
		return "", errors.New("cannot secure coordinator data directory permissions")
	}
	return canonical, nil
}

func isUnsafeDataRoot(directory, home string) bool {
	directory = filepath.Clean(directory)
	canonicalHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		canonicalHome = filepath.Clean(home)
	}
	return directory == filepath.Dir(directory) || directory == filepath.Clean(home) || directory == canonicalHome
}

func validateOwnedDirectory(metadata os.FileInfo, owner int) error {
	if metadata == nil || !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
		return errors.New("not a regular directory")
	}
	stat, ok := metadata.Sys().(*syscall.Stat_t)
	if !ok || uint32(owner) != stat.Uid {
		return errors.New("directory belongs to another user")
	}
	return nil
}
