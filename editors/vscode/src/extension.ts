/**
 * Meshfleet Inspector — read-only fleet/receipts/councils views for VS Code.
 *
 * All ledger access goes through the shipped `agent-mesh` CLI (`--export`
 * for data, `--verify` for the integrity verdict); see model.ts for why.
 * The extension never writes to the ledger.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import {
  parseLedgerExport,
  parseVerifyEnvelope,
  verdictFromVerifyOutput,
  type CouncilView,
  type FleetView,
  type LedgerModel,
} from "./model";

function cliParts(): { cmd: string; baseArgs: string[] } {
  const raw = vscode.workspace.getConfiguration("meshfleet").get<string>("cliCommand", "npx agent-mesh");
  const parts = raw.split(/\s+/).filter(Boolean);
  return { cmd: parts[0] ?? "npx", baseArgs: parts.slice(1) };
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { cmd, baseArgs } = cliParts();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return new Promise((resolve) => {
    execFile(
      cmd,
      [...baseArgs, ...args],
      { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function loadModel(): Promise<LedgerModel> {
  const { code, stdout, stderr } = await runCli(["--export"]);
  if (code !== 0) throw new Error(stderr.trim() || `agent-mesh --export exited ${code}`);
  return parseLedgerExport(stdout);
}

type VerifyCommandResult = {
  ok: boolean;
  summary: string;
  findings: Array<{ severity: string; check: string; detail: string }>;
};

async function verifyLedger(): Promise<VerifyCommandResult> {
  let { code, stdout } = await runCli(["--verify", "--json"]);
  try {
    const envelope = parseVerifyEnvelope(stdout);
    return { ok: envelope.ok, summary: envelope.summary, findings: envelope.findings };
  } catch {
    const fallback = await runCli(["--verify"]);
    stdout = fallback.stdout;
    code = fallback.code;
  }

  const verdict = verdictFromVerifyOutput(code, stdout);
  return { ok: verdict.ok, summary: verdict.summary, findings: [] };
}

// --- tree providers ---------------------------------------------------------

type FleetNode = { kind: "fleet"; fleet: FleetView } | { kind: "agent"; fleetId: string; role: string; status: string };

const AGENT_ICONS: Record<string, string> = {
  running: "sync~spin",
  complete: "check",
  failed: "error",
  interrupted: "debug-disconnect",
  pending: "clock",
};

class FleetsProvider implements vscode.TreeDataProvider<FleetNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private model: LedgerModel = { fleets: [], councils: [] };
  private error: string | undefined;

  setModel(m: LedgerModel): void {
    this.model = m;
    this.error = undefined;
    this._onDidChange.fire();
  }
  setError(message: string): void {
    this.error = message;
    this._onDidChange.fire();
  }

  getTreeItem(node: FleetNode): vscode.TreeItem {
    if (node.kind === "fleet") {
      const f = node.fleet;
      const item = new vscode.TreeItem(
        `${f.id}`,
        f.agents.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.description = `${f.status} · ${f.agents.length} agent${f.agents.length === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon(f.status === "running" ? "rocket" : f.status === "failed" ? "error" : "pass");
      return item;
    }
    const item = new vscode.TreeItem(node.role, vscode.TreeItemCollapsibleState.None);
    item.description = node.status;
    item.iconPath = new vscode.ThemeIcon(AGENT_ICONS[node.status] ?? "circle-outline");
    return item;
  }

  getChildren(node?: FleetNode): FleetNode[] {
    if (this.error !== undefined) return [];
    if (!node) return this.model.fleets.map((fleet) => ({ kind: "fleet", fleet }));
    if (node.kind === "fleet") {
      return node.fleet.agents.map((a) => ({ kind: "agent", fleetId: node.fleet.id, role: a.role, status: a.status }));
    }
    return [];
  }
}

class CouncilsProvider implements vscode.TreeDataProvider<CouncilView> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private councils: CouncilView[] = [];

  setModel(m: LedgerModel): void {
    this.councils = m.councils;
    this._onDidChange.fire();
  }

  getTreeItem(c: CouncilView): vscode.TreeItem {
    const item = new vscode.TreeItem(c.subject || c.messageId, vscode.TreeItemCollapsibleState.None);
    item.description = `${c.status} · ${c.approvals}/${c.quorum} approvals · ${c.voters} voters`;
    item.iconPath = new vscode.ThemeIcon(
      c.status === "ratified" ? "pass-filled" : c.status === "rejected" ? "close" : c.status === "expired" ? "history" : "comment-discussion",
    );
    item.tooltip = `${c.subject}\nstatus: ${c.status}\nquorum: ${c.quorum}\napprovals: ${c.approvals} of ${c.voters} voters`;
    return item;
  }

  getChildren(node?: CouncilView): CouncilView[] {
    return node ? [] : this.councils;
  }
}

// --- activation --------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const fleets = new FleetsProvider();
  const councils = new CouncilsProvider();
  const output = vscode.window.createOutputChannel("Meshfleet");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "meshfleet.verify";
  status.text = "$(shield) Meshfleet";
  status.tooltip = "Verify ledger integrity";
  status.show();

  async function refresh(): Promise<void> {
    try {
      const model = await loadModel();
      fleets.setModel(model);
      councils.setModel(model);
      const verdict = await verifyLedger();
      status.text = verdict.ok ? "$(shield) Meshfleet ✓" : "$(alert) Meshfleet ✗";
      status.tooltip = verdict.summary;
      status.backgroundColor = verdict.ok ? undefined : new vscode.ThemeColor("statusBarItem.errorBackground");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fleets.setError(msg);
      status.text = "$(shield) Meshfleet — CLI not found?";
      status.tooltip = `${msg}\n\nSet meshfleet.cliCommand (default: npx agent-mesh; requires 'npm install meshfleet').`;
    }
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("meshfleet.fleets", fleets),
    vscode.window.registerTreeDataProvider("meshfleet.councils", councils),
    vscode.commands.registerCommand("meshfleet.refresh", refresh),
    vscode.commands.registerCommand("meshfleet.verify", async () => {
      const { stdout } = await runCli(["--verify", "--json"]);
      output.clear();
      let verdict: { ok: boolean; summary: string };
      try {
        const envelope = parseVerifyEnvelope(stdout);
        verdict = { ok: envelope.ok, summary: envelope.summary };
        output.appendLine(verdict.summary);
        if (!verdict.ok) {
          for (const finding of envelope.findings) {
            output.appendLine(`${finding.severity} ${finding.check} — ${finding.detail}`);
          }
        }
      } catch {
        const fallback = await runCli(["--verify"]);
        verdict = verdictFromVerifyOutput(fallback.code, fallback.stdout);
        output.appendLine(fallback.stdout || fallback.stderr);
      }
      output.show(true);
      if (verdict.ok) void vscode.window.showInformationMessage(`Meshfleet ledger: ${verdict.summary}`);
      else void vscode.window.showWarningMessage(`Meshfleet ledger: ${verdict.summary}`);
      await refresh();
    }),
    vscode.commands.registerCommand("meshfleet.export", async () => {
      const { code, stdout, stderr } = await runCli(["--export"]);
      if (code !== 0) {
        void vscode.window.showErrorMessage(`agent-mesh --export failed: ${stderr.trim()}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: "json", content: stdout });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    status,
    output,
  );

  const intervalSec = vscode.workspace.getConfiguration("meshfleet").get<number>("refreshIntervalSeconds", 0);
  if (intervalSec > 0) {
    const timer = setInterval(() => void refresh(), intervalSec * 1_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  void refresh();
}

export function deactivate(): void {}
