import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function csharpString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Compile a native Windows executable that forwards all of its argv to a Node
 * witness script. This mirrors OpenCode's native .exe launch shape without
 * making Node interpret OpenCode's leading global flags as Node flags.
 */
export function compileWindowsNodeLauncher(outputPath: string, witnessPath: string): string {
  assert.equal(process.platform, "win32", "the native launcher is Windows-only");
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const compiler = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find(existsSync);
  assert.ok(compiler, "Windows CI requires the .NET Framework C# compiler");

  const sourcePath = `${outputPath}.cs`;
  const source = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

internal static class Program
{
    private static string Quote(string value)
    {
        if (value.Length == 0) return "\\\"\\\"";
        bool needsQuotes = false;
        foreach (char ch in value)
        {
            if (char.IsWhiteSpace(ch) || ch == '\\"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return value;

        StringBuilder result = new StringBuilder("\\\"");
        int backslashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\\\')
            {
                backslashes += 1;
                continue;
            }
            if (ch == '\\"')
            {
                result.Append('\\\\', backslashes * 2 + 1);
                result.Append(ch);
                backslashes = 0;
                continue;
            }
            result.Append('\\\\', backslashes);
            result.Append(ch);
            backslashes = 0;
        }
        result.Append('\\\\', backslashes * 2);
        result.Append('\\"');
        return result.ToString();
    }

    private static int Main(string[] args)
    {
        List<string> forwarded = new List<string>();
        forwarded.Add(Quote(${csharpString(witnessPath)}));
        foreach (string arg in args) forwarded.Add(Quote(arg));
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = ${csharpString(process.execPath)};
        start.Arguments = string.Join(" ", forwarded.ToArray());
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process child = Process.Start(start);
        child.WaitForExit();
        return child.ExitCode;
    }
}
`;
  writeFileSync(sourcePath, source);
  execFileSync(compiler, ["/nologo", "/target:exe", `/out:${outputPath}`, sourcePath], {
    stdio: "pipe",
  });
  return outputPath;
}
