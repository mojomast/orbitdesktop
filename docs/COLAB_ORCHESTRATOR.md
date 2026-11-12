# Google Colab runtimes

Google Colab (`colab.research.google.com`, the `colab` CLI) is an Orbit app for the official [Colab CLI](https://github.com/googlecolab/google-colab-cli) (`google-colab-cli`). Open **Google Colab** from the pinned desktop icon, the **Google Colab** button at the top of Start, the first section of the Orbit menu, or the command palette (search `colab`). The window is `orbit://surface/colab-runtime`. The route is `/api/colab-runtime`. Orbit's project board is a separate app at `orbit://surface/collab`.

The CLI already streams kernel stdout, stderr, and display output. A separate localhost extension would not be able to push that stream to the browser through Orbit's existing token, so this is a first-class route on the Orbit server. The server process runs `colab` with an argument array. It does not use a shell. It does not read, copy, or log the Colab token or `ORBIT_TOKEN`.

## What you can do

- See compute-unit balance, hourly rate, and active assignments (`colab usage`).
- List sessions, hardware, machine shape, and status.
- Create a session on any runtime the installed CLI accepts. The documented set is CPU, T4, L4, A100, H100, G4, TPU v5e1, and TPU v6e1. **Read CLI runtimes** runs `colab help new` and replaces that list with what this install reports. High memory is offered only where the CLI honors `--high-mem` (not L4 or the TPUs).
- The create form shows a compute-unit warning and stays disabled until it is confirmed. Stop asks again before `colab stop`.
- Upload, download, list, edit, and delete remote files. Download and history export come back through Orbit.
- Execute a script or notebook, paste code, start a one-shot `colab run`, pipe a REPL snippet, or pipe a console command.
- Mount Drive or start VM Google auth. Those commands wait for a person. The live log shows the URL they print, and **Send Enter** continues them. They are not something an agent should run unattended.
- Tail `colab log`, or export it as a notebook, Markdown, text, or JSONL.
- Open the `colab url` link for the live Colab page.
- Query `nvidia-smi` through `colab console` while a kernel execution is in progress. CPU and TPU sessions report no NVIDIA GPU.

G4 (RTX PRO 6000 Blackwell, 96GB) is one runtime in the list. It is a good fit for LoRA SFT of Qwen/Qwen3-8B, and the training preset can start there, but the same preset accepts every other runtime.

## Live output

Start a run and the pane follows `GET /api/colab-runtime/stream` with the Orbit bearer token. The body is server-sent events. Fetch is used so the token stays in the header. xterm.js draws the raw stream, including carriage returns and ANSI color, so tqdm and Hugging Face bars repaint one line instead of printing a new line for every tick.

Images the CLI saves (`[Image saved to: …]`) and images or HTML embedded in a finished `*_output.ipynb` are copied into the job folder and shown beside the terminal. HTML is framed without scripts.

The log is appended under the Orbit runtime directory, `colab-orchestrator/jobs/<id>/output.log`. Closing the pane does not stop the CLI. The window polls `jobs` every few seconds, lists id, action, state, start, end, exit code, and bytes for the selected session or for every session, and attaches the terminal at the start of the log. A job started from this server, including one an agent started with `POST /api/colab-runtime`, is followed automatically while it is the newest running job for the selected session.

Each background step runs in a detached worker that writes the log. Restarting Orbit does not signal that worker. The next Orbit process tails the same log, shows the job as running, and marks it exited when the worker records an exit code. A multi-step training job keeps the step that is in flight; steps that had not started are not resumed. Jobs that were started before detached workers existed still stop when that older Orbit process exits. The local log is capped at 64MB.

`colab exec` and `colab run` pass `--timeout`. In the CLI that value is a quiet period, not a wall clock: output refreshes it, and a long silent stretch (a model load with no prints) still needs a higher timeout. The default in the app is 3600 seconds. The Orbit-side watcher is slightly longer than that quiet period and also stops the local process after 24 hours. Stopping the local process does not release the VM. `colab run` without keep is the CLI's own create-run-stop path; killing it early can skip that cleanup, so stop the session afterward if it is still listed.

## Agents

`POST /api/colab-runtime` uses the same Origin check and `Authorization: Bearer` token as the rest of Orbit. It is not a workspace-controller action.

```json
{"action":"usage"}
{"action":"sessions"}
{"action":"discover"}
{"action":"create","session":"trainer","accelerator":"G4","high_mem":false,"confirm_cost":true}
{"action":"exec","session":"trainer","file":"/absolute/train.py","timeout":3600}
{"action":"tail","job_id":"<id>","after":0}
{"action":"download","session":"trainer","remote":"/content/adapter/adapter_model.safetensors"}
{"action":"stop","session":"trainer","confirm_stop":true}
```

`tail` returns `text` with the raw carriage returns and `plain` with those updates folded. `GET /api/colab-runtime/stream?job=<id>&after=<bytes>` stays open and emits `data`, `rich`, and `status` events.

A training run is the same steps in one job:

```json
{"action":"train","session":"qwen-lora","accelerator":"G4","confirm_cost":true,"uploads":[{"local":"/absolute/data.jsonl","remote":"/content/data.jsonl"}],"packages":["torch","transformers","peft"],"script":"/absolute/train.py","timeout":21600}
```

`accelerator` is required in the sense that you name one. `cpu` is valid. The job fails closed before `colab new` if a local file is missing. A failed later step leaves the VM up; stop it explicitly.

Other actions: `status`, `url`, `restart-kernel`, `ls`, `rm` (`confirm`), `upload` (host path), `read`, `write` (`confirm`), `repl`, `console`, `install`, `drivemount`, `vm-auth`, `log`, `gpu`, `jobs`, `job`, `cancel` (`confirm`), `job-input`, `pay`, `update-check`. `ssh` is refused because it needs an interactive terminal and a private key. `pay` returns the Colab signup URL and does not open a browser on the host. `update-check` does not pass `--install`.

Do not point uploads at `token.json`, `~/.config/colab-cli`, the Orbit session token, or SSH keys. The route rejects those paths.

## Activate on the deployment host

Nothing in this tree contacts the live host. After this build is the one you run:

1. The CLI is already installed for the Orbit user at `/home/box/.local/bin/colab` and already signed in. Leave `~/.config/colab-cli/token.json` where it is. Do not print it, copy it into the unit file, or put it in the chat.
2. If `colab` is not on the service PATH, set `ORBIT_COLAB_BIN` to that executable. The server also looks at `/home/box/.local/bin/colab` when the variable is unset. Optional `ORBIT_COLAB_HOME` is the home directory whose `.config/colab-cli` the CLI should use. Optional `ORBIT_COLAB_PATH` adds extra absolute PATH entries the CLI needs. The child environment is a fresh `HOME`, `PATH`, `LANG`, `TERM`, and `TMPDIR`. It does not inherit `ORBIT_TOKEN`.
3. Restart Orbit with the build that contains this route. Open **Colab**, choose **Read CLI runtimes**, and confirm usage loads. That is the check that the existing login works.
4. Create a session only after the warning is acceptable. Stop it when the work is done. Idle sessions keep spending compute units. Stopping or restarting Orbit does not stop them.

There is no `extensions.py` activation step. This process is the Orbit server, on the bind address Orbit already uses, and every Colab route requires the existing owner token.
