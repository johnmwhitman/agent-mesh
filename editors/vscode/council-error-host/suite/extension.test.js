'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

const { writeMode, waitForMarker, releaseA, markerDir } = globalThis.__councilErrorHost;

suite('Council-error Extension Host — marker held-A race', function () {
  this.timeout(180_000);

  let providers;
  let statusItems;
  let origRegister;
  let origStatus;

  function installHooks() {
    providers = new Map();
    statusItems = [];
    origRegister = vscode.window.registerTreeDataProvider.bind(vscode.window);
    vscode.window.registerTreeDataProvider = (viewId, provider) => {
      providers.set(viewId, provider);
      return origRegister(viewId, provider);
    };
    origStatus = vscode.window.createStatusBarItem.bind(vscode.window);
    vscode.window.createStatusBarItem = (...args) => {
      const item = origStatus(...args);
      statusItems.push(item);
      return item;
    };
  }

  function restoreHooks() {
    if (origRegister) vscode.window.registerTreeDataProvider = origRegister;
    if (origStatus) vscode.window.createStatusBarItem = origStatus;
  }

  async function fleetIds() {
    const p = providers.get('meshfleet.fleets');
    assert.ok(p, 'meshfleet.fleets provider captured');
    const kids = await Promise.resolve(p.getChildren());
    return (kids || []).filter((n) => n && n.kind === 'fleet').map((n) => n.fleet.id);
  }

  async function councilSubjects() {
    const p = providers.get('meshfleet.councils');
    assert.ok(p, 'meshfleet.councils provider captured');
    const kids = await Promise.resolve(p.getChildren());
    return (kids || []).map((c) => c.subject || c.messageId);
  }

  function meshStatus() {
    const item = statusItems.find((s) => String(s.text || '').includes('Meshfleet'));
    assert.ok(item, 'Meshfleet status bar item captured');
    return item;
  }

  teardown(() => {
    try {
      releaseA();
    } catch {
      /* cleanup best-effort */
    }
    restoreHooks();
  });

  test('warm B activate → held A → B views → C clear+error → release A → reassert C', async () => {
    assert.ok(markerDir && fs.existsSync(markerDir), 'marker_dir prepared');

    // Hooks BEFORE any contributed refresh / activate.
    installHooks();

    // Warm B: activate, then explicitly await contributed refresh — activate's
    // void refresh() can still be in flight when activate() resolves.
    writeMode({ mode: 'B-success', hold: false });
    const ext =
      vscode.extensions.getExtension('meshfleet.meshfleet-inspector') ||
      vscode.extensions.all.find((e) => e.packageJSON && e.packageJSON.name === 'meshfleet-inspector');
    assert.ok(ext, 'meshfleet inspector present');
    await ext.activate();
    assert.equal(ext.isActive, true);
    assert.ok(providers.has('meshfleet.fleets'), 'hooks captured fleets provider');
    assert.ok(providers.has('meshfleet.councils'), 'hooks captured councils provider');
    assert.ok(statusItems.length > 0, 'hooks captured status item');
    await vscode.commands.executeCommand('meshfleet.refresh');
    assert.deepEqual(await fleetIds(), ['B-fleet']);
    assert.deepEqual(await councilSubjects(), ['B-council']);

    // Separate contributed A refresh; retain promise. CLI records a-entered and waits for release.
    writeMode({ mode: 'A-success', hold: true, marker_dir: markerDir });
    const aPromise = vscode.commands.executeCommand('meshfleet.refresh');
    await waitForMarker('a-entered');

    writeMode({ mode: 'B-success', hold: false });
    await vscode.commands.executeCommand('meshfleet.refresh');
    assert.deepEqual(await fleetIds(), ['B-fleet']);
    assert.deepEqual(await councilSubjects(), ['B-council']);
    assert.doesNotMatch(String(meshStatus().text), /CLI not found/);

    writeMode({ mode: 'C-fail', hold: false });
    await vscode.commands.executeCommand('meshfleet.refresh');
    assert.deepEqual(await fleetIds(), []);
    assert.deepEqual(await councilSubjects(), []);
    {
      const st = meshStatus();
      assert.match(String(st.text), /CLI not found/);
      assert.match(String(st.tooltip || ''), /CLI export failed|not found|exited/i);
    }

    releaseA();
    await aPromise;
    await waitForMarker('a-completed');

    assert.deepEqual(await fleetIds(), [], 'late A must not repopulate Fleets');
    assert.deepEqual(await councilSubjects(), [], 'late A must not repopulate Councils');
    assert.match(String(meshStatus().text), /CLI not found/, 'C error remains after late A');
  });
});
