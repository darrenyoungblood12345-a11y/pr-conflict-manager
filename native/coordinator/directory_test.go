package coordinator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExistingUserOwnedDataDirectoryIsPrivateBeforeOpeningStores(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "existing")
	if err := os.Mkdir(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	node, err := OpenNode(Options{ID: "one", DataDir: directory, BootstrapIfNew: true, TestTimers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = node.Close() })
	metadata, err := os.Stat(directory)
	if err != nil || metadata.Mode().Perm() != 0700 {
		t.Fatal("existing data directories must become 0700 before stores are opened")
	}
	store, err := os.Stat(filepath.Join(directory, "raft.db"))
	if err != nil || store.Mode().Perm()&0077 != 0 {
		t.Fatal("durable store must not be readable by other users")
	}
}

func TestDataDirectoryRejectsSymlinksFilesRootsAndWrongOwners(t *testing.T) {
	parent := t.TempDir()
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(parent, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(parent, "file")
	if err := os.WriteFile(file, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{link, file, filepath.VolumeName(home) + string(filepath.Separator), home} {
		if _, err := prepareDataDirectory(directory); err == nil {
			t.Fatal("unsafe data directory was accepted")
		}
	}
	metadata, err := os.Lstat(target)
	if err != nil || metadata.Mode().Perm() != 0755 {
		t.Fatal("rejecting a symlink must not chmod its target")
	}
	if err := validateOwnedDirectory(metadata, os.Getuid()+1); err == nil {
		t.Fatal("another owner's directory must be rejected before permission changes")
	}
	if _, err := os.Stat(filepath.Join(target, "raft.db")); !os.IsNotExist(err) {
		t.Fatal("rejected directories must not create a durable store")
	}
}
