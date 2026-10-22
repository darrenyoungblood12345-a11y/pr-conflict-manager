package coordinator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
	"go.etcd.io/bbolt"
)

// This subprocess is an actual, separate supervising parent. Killing it closes
// the OS pipe rather than calling a graceful-stop helper in the test process.
func TestSupervisedParentProcess(t *testing.T) {
	binary := os.Getenv("AGENT_PR_TEST_SUPERVISED_BIN")
	if binary == "" {
		return
	}
	child := exec.Command(binary, "--bootstrap-if-new", "--exit-on-stdin-close", "--id", "supervised", "--data-dir", os.Getenv("AGENT_PR_TEST_SUPERVISED_DATA"))
	input, err := child.StdinPipe()
	if err != nil {
		os.Exit(10)
	}
	child.Stdout = os.Stdout
	child.Stderr = io.Discard
	if err := child.Start(); err != nil {
		os.Exit(11)
	}
	if err := os.WriteFile(os.Getenv("AGENT_PR_TEST_SUPERVISED_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		_ = child.Process.Kill()
		os.Exit(12)
	}
	for {
		time.Sleep(time.Second)
		runtime.KeepAlive(input)
		runtime.KeepAlive(child)
	}
}

func readReady(t *testing.T, reader io.Reader) Ready {
	t.Helper()
	type decoded struct {
		ready Ready
		err   error
	}
	result := make(chan decoded, 1)
	go func() {
		var ready Ready
		err := json.NewDecoder(reader).Decode(&ready)
		result <- decoded{ready: ready, err: err}
	}()
	select {
	case value := <-result:
		if value.err != nil || value.ready.URL == "" || len(value.ready.Token) < 32 {
			t.Fatal("helper did not return a valid private readiness object")
		}
		return value.ready
	case <-time.After(8 * time.Second):
		t.Fatal("helper readiness timed out")
		return Ready{}
	}
}

func cliSnapshot(ready Ready) (Snapshot, error) {
	request, _ := http.NewRequest(http.MethodGet, ready.URL+"/v1/snapshot", nil)
	request.Header.Set("Authorization", "Bearer "+ready.Token)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		return Snapshot{}, err
	}
	defer response.Body.Close()
	var snapshot Snapshot
	err = json.NewDecoder(response.Body).Decode(&snapshot)
	return snapshot, err
}

func TestForcedParentDeathStopsSupervisedCLIAndReopensItsDataDirectory(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "coordinator")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-trimpath", "-o", binary, "./cmd/coordinator")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("could not build actual CLI fixture: %s", output)
	}
	dataDirectory := filepath.Join(directory, "workspace")
	pidFile := filepath.Join(directory, "helper.pid")
	parent := exec.Command(os.Args[0], "-test.run=^TestSupervisedParentProcess$")
	parent.Env = append(os.Environ(), "AGENT_PR_TEST_SUPERVISED_BIN="+binary, "AGENT_PR_TEST_SUPERVISED_DATA="+dataDirectory, "AGENT_PR_TEST_SUPERVISED_PID="+pidFile)
	parent.Stderr = io.Discard
	output, err := parent.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = parent.Process.Kill()
		_ = parent.Wait()
		if data, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(string(data)); err == nil {
				if process, err := os.FindProcess(pid); err == nil {
					_ = process.Kill()
				}
			}
		}
	})
	ready := readReady(t, output)
	eventually(t, "supervised CLI never became authoritative", func() bool {
		snapshot, err := cliSnapshot(ready)
		return err == nil && snapshot.HasAuthority
	})
	encoded, _ := json.Marshal(taskRequest(proposal("survives-parent", "run")))
	request, _ := http.NewRequest(http.MethodPost, ready.URL+"/v1/commands", strings.NewReader(string(encoded)))
	request.Header.Set("Authorization", "Bearer "+ready.Token)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal("could not register task before forced parent death")
	}
	var result CommandResult
	err = json.NewDecoder(response.Body).Decode(&result)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal("invalid command response from supervised helper")
	}
	requireOK(t, result)
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = parent.Wait()
	eventually(t, "orphaned helper still holds the workspace after its parent was killed", func() bool {
		store, err := raftboltdb.New(raftboltdb.Options{Path: filepath.Join(dataDirectory, "raft.db"), BoltOptions: &bbolt.Options{Timeout: 50 * time.Millisecond}})
		if err != nil {
			return false
		}
		_ = store.Close()
		return true
	})
	// No supervised flag here: default standalone use must remain alive even
	// with a closed stdin while the same data is reopened through the real CLI.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reopened := exec.CommandContext(ctx, binary, "--bootstrap-if-new", "--id", "supervised", "--data-dir", dataDirectory)
	reopened.Stderr = io.Discard
	reopenedOutput, err := reopened.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Process.Kill(); _ = reopened.Wait() })
	reopenedReady := readReady(t, reopenedOutput)
	eventually(t, "reopened standalone CLI did not recover persisted work and authority", func() bool {
		snapshot, err := cliSnapshot(reopenedReady)
		return err == nil && snapshot.HasAuthority && snapshot.Tasks["survives-parent"] != nil
	})
}
