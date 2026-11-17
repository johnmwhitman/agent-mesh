/**
 * Latest-started refresh controller for overlapping async UI loads.
 *
 * Every UI write after an await is gated on the generation that started
 * that refresh still being current, so an older loadModel / verifyLedger
 * result (or late error) cannot replace newer sidebar or status state.
 */

export type RefreshModel = {
  fleets: unknown[];
  councils: unknown[];
};

export type RefreshVerdict = {
  ok: boolean;
  summary: string;
};

export type RefreshDeps<M extends RefreshModel = RefreshModel> = {
  loadModel: () => Promise<M>;
  verifyLedger: () => Promise<RefreshVerdict>;
};

export type RefreshUi<M extends RefreshModel = RefreshModel> = {
  setModel: (model: M) => void;
  setStatus: (verdict: RefreshVerdict) => void;
  setError: (message: string) => void;
};

export class LatestStartedRefresh<M extends RefreshModel = RefreshModel> {
  private generation = 0;

  /** Generation of the most recently started refresh (0 before any call). */
  get currentGeneration(): number {
    return this.generation;
  }

  async run(deps: RefreshDeps<M>, ui: RefreshUi<M>): Promise<void> {
    const started = ++this.generation;
    try {
      const model = await deps.loadModel();
      if (started !== this.generation) return;
      ui.setModel(model);

      const verdict = await deps.verifyLedger();
      if (started !== this.generation) return;
      ui.setStatus(verdict);
    } catch (err) {
      if (started !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      ui.setError(message);
    }
  }
}
