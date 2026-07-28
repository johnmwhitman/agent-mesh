process.stdin.once("data", () => process.stdout.write("fault stdout pollution\n"));
process.stdin.resume();
