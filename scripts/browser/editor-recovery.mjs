import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

// Runs in an isolated browser draft; never touches an existing user's project.
async function stored({ id, write }) {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open("fun.dev.model-editor", 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", write ? "readwrite" : "readonly"),
        s = tx.objectStore("drafts"),
        r = write ? s.put(write, id) : s.get(id);
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function editorRecoveryChecks({ browser, base }) {
  const errors = [];
  for (const fault of ["journal", "receipts", "geometry", "read"]) {
    const context = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        serviceWorkers: "block",
        acceptDownloads: true,
      }),
      page = watch(await context.newPage(), errors),
      id = `recovery-${fault}`,
      key = `fun.dev.editor.project.v2:${id}`;
    try {
      await page.goto(`${base}/editor/?lang=zh&draft=${id}`);
      await page.waitForFunction(() => window.funEditor);
      await page.evaluate(async () => {
        const { emptyProject } = await import("/editor/document.js");
        funEditor.loadProject(emptyProject("Important source"));
        funEditor.apply([
          { op: "create", id: "part", kind: "box" },
          {
            op: "recipe",
            id: "part",
            definition: {
              parameters: { width: { value: 1 } },
              generator: {
                kind: "box",
                options: { size: [{ $param: "width" }, 1, 1] },
              },
              steps: [],
            },
          },
        ]);
        await funEditor.flush();
      });
      const source = await page.evaluate(stored, { id });
      if (fault === "receipts") {
        source.receipts = [null];
        source.activity = [
          { label: "Damaged log", revision: source.revision, fields: [null] },
        ];
        source.checkpoints = [null];
      }
      if (fault === "geometry") source.project.nodes = [null];
      await page.evaluate(stored, { id, write: source });
      const rawJournal = fault === "journal" ? '{"project":' : null;
      await page.evaluate(
        ({ key, rawJournal }) => {
          if (rawJournal === null) localStorage.removeItem(key);
          else localStorage.setItem(key, rawJournal);
        },
        { key, rawJournal },
      );
      if (fault === "read") {
        await page.evaluate(() => sessionStorage.setItem("fault-read", "1"));
        await page.addInitScript(() => {
          const open = indexedDB.open.bind(indexedDB);
          window.restoreDraftStorage = () => {
            indexedDB.open = open;
            sessionStorage.removeItem("fault-read");
          };
          if (sessionStorage.getItem("fault-read"))
            indexedDB.open = () => {
              throw new Error("Storage temporarily unavailable");
            };
        });
      }
      await page.reload();
      await page.waitForFunction(() => window.funEditor);
      if (fault === "read") {
        const state = await page.evaluate(() => funEditor.inspect());
        assert.equal(state.writable, false);
        assert.equal(state.recovery.code, "draft_read");
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), key),
          null,
        );
        await page.evaluate(() => restoreDraftStorage());
        assert.deepEqual(await page.evaluate(stored, { id }), source);
        await Promise.all([
          page.waitForNavigation(),
          page.locator("#draft-retry").click(),
        ]);
        await page.waitForFunction(() => window.funEditor);
        assert.equal(
          await page.evaluate(() => funEditor.inspect().writable),
          true,
        );
        assert.deepEqual(
          await page.evaluate(() => funEditor.getProject()),
          source.project,
        );
        assert.equal(
          await page.evaluate(async () => (await funEditor.flush()).state),
          "saved",
        );
        continue;
      }
      const recovered = await page.evaluate(async () => {
        let error;
        try {
          funEditor.apply([{ op: "renameProject", name: "Overwrite" }]);
        } catch (e) {
          error = e.code;
        }
        return {
          state: funEditor.inspect(),
          project: funEditor.getProject(),
          session: funEditor.getSession(),
          error,
          persistence: await funEditor.flush(),
        };
      });
      assert.equal(recovered.state.writable, false);
      assert.equal(recovered.project.name, "Important source");
      assert.equal(recovered.error, "recovery");
      assert.equal(recovered.persistence.state, "recovery");
      assert.deepEqual(recovered.session.project, source.project);
      if (fault !== "geometry") {
        assert.ok(recovered.project.nodes[0].recipe);
        assert.deepEqual(recovered.session.recoverySources.indexedDB, source);
        assert.equal(recovered.session.recoverySources.journal, rawJournal);
      }
      for (const control of ["#activity", "#checkpoints"]) {
        await page.locator(control).click();
        await page.locator("#info-dialog").waitFor({ state: "visible" });
        await page.locator('[data-close="info-dialog"]').click();
      }
      const downloaded = page.waitForEvent("download");
      await page.locator("#draft-original").click();
      const download = await downloaded,
        backup = JSON.parse(await readFile(await download.path(), "utf8"));
      if (fault === "geometry") assert.deepEqual(backup, source.project);
      else {
        assert.equal(backup.format, "fun.dev/model-recovery");
        assert.deepEqual(backup.sources.indexedDB, source);
        assert.equal(backup.sources.journal, rawJournal);
      }
      if (fault === "journal")
        for (const [width, height] of [
          [1024, 768],
          [1920, 1080],
        ]) {
          await page.setViewportSize({ width, height });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          );
          await page.screenshot({
            path: resolve(results, `editor-storage-recovery-${width}.png`),
          });
        }
      const popup = page.waitForEvent("popup");
      await page.locator("#draft-copy").click();
      const copy = watch(await popup, errors);
      await copy.waitForFunction(() => window.funEditor);
      const copyState = await copy.evaluate(async () => {
        if (funEditor.getProject().nodes.length)
          funEditor.apply([
            { op: "recipeParameters", id: "part", values: { width: 2 } },
          ]);
        await funEditor.flush();
        return { state: funEditor.inspect(), project: funEditor.getProject() };
      });
      assert.equal(copyState.state.writable, true);
      assert.equal(copyState.state.recovery, null);
      assert.notEqual(copyState.state.draftId, id);
      if (fault !== "geometry")
        assert.equal(
          copyState.project.nodes[0].recipe.parameters.width.value,
          2,
        );
      await copy.close();
      assert.deepEqual(await page.evaluate(stored, { id }), source);
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), key),
        rawJournal,
      );
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
}
