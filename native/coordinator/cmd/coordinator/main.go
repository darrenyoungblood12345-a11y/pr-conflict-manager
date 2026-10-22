package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	coordinator "agent-pr-monitor/coordinator"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Coordinator failed:", err)
		os.Exit(1)
	}
}

func run() error {
	options := coordinator.Options{}
	exitOnStdinClose := false
	generateIdentity := false
	lanConfigStdin := false
	workspaceID := ""
	flag.StringVar(&options.ID, "id", "", "stable local node identifier")
	flag.StringVar(&options.DataDir, "data-dir", "", "private persistent workspace directory")
	flag.StringVar(&options.APIAddress, "api-address", "127.0.0.1:0", "numeric loopback API address")
	flag.StringVar(&options.RaftAddress, "raft-address", "127.0.0.1:0", "numeric loopback Raft address")
	flag.BoolVar(&options.Bootstrap, "bootstrap", false, "bootstrap a new single-node workspace, never existing state")
	flag.BoolVar(&options.BootstrapIfNew, "bootstrap-if-new", false, "bootstrap only if no persisted Raft state exists; otherwise resume the saved configuration")
	flag.BoolVar(&exitOnStdinClose, "exit-on-stdin-close", false, "stop gracefully when the supervising parent's stdin pipe closes")
	flag.BoolVar(&generateIdentity, "generate-lan-identity", false, "emit a new private device identity to the supervising parent and exit")
	flag.StringVar(&workspaceID, "workspace-id", "", "workspace identifier for identity generation")
	flag.BoolVar(&lanConfigStdin, "lan-config-stdin", false, "read one bounded private LAN configuration JSON line from the parent pipe")
	flag.Parse()
	if generateIdentity {
		if lanConfigStdin {
			return fmt.Errorf("identity generation and LAN startup are separate operations")
		}
		identity, err := coordinator.GenerateLANIdentity(workspaceID, options.ID)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(identity)
	}
	input := bufio.NewReaderSize(os.Stdin, 64*1024+1)
	if lanConfigStdin {
		line, err := input.ReadSlice('\n')
		if err != nil || len(line) > 64*1024 {
			return fmt.Errorf("a bounded private LAN startup JSON line is required")
		}
		config, err := coordinator.DecodeLANConfig(line)
		clear(line)
		if err != nil {
			return err
		}
		options.LAN = &config
	}
	node, err := coordinator.OpenNode(options)
	if err != nil {
		return err
	}
	defer node.Close()
	api, err := coordinator.StartAPI(node, options.APIAddress)
	if err != nil {
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = api.Close(shutdown)
	}()
	// The parent consumes this single secret-bearing line. No token is emitted
	// by the HTTP handler, Raft logger, error messages, or shutdown path.
	if err := json.NewEncoder(os.Stdout).Encode(api.Ready); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if exitOnStdinClose {
		closed := make(chan struct{})
		go func() {
			_, _ = io.Copy(io.Discard, input)
			close(closed)
		}()
		select {
		case <-ctx.Done():
		case <-closed:
		}
	} else {
		<-ctx.Done()
	}
	return nil
}
