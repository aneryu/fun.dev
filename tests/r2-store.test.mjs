import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createR2Store } from "../scripts/r2-store.mjs";

test("S3 adapter signs writes and preserves R2 conditional headers and ETags", async () => {
  const requests = [];
  let status = 200;
  const store = createR2Store({ R2_ENDPOINT:"https://test.r2.cloudflarestorage.com", R2_BUCKET:"fixture", R2_ACCESS_KEY_ID:"test", R2_SECRET_ACCESS_KEY:"test" }, {
    async handle(request) {
      requests.push(request);
      return { response:{statusCode:status, headers:{etag:'"revision"',"content-type":"application/xml"},body:Readable.from([status===412?'<Error><Code>PreconditionFailed</Code></Error>':request.method==="GET"?'[]':''])} };
    },
  });
  try {
    assert.equal((await store.get("games.json")).etag,'"revision"');
    await store.put("games.json",Buffer.from('[]'),{type:"application/json",cache:"no-store",ifMatch:'"revision"'});
    assert.equal(requests.at(-1).headers['if-match'],'"revision"');
    assert.equal(requests.at(-1).headers['cache-control'],'no-store');
    assert.match(requests.at(-1).headers.authorization,/AWS4-HMAC-SHA256/);
    await store.put("game.js",Buffer.from('export {};'),{type:"text/javascript",ifNoneMatch:"*"});
    assert.equal(requests.at(-1).headers['if-none-match'],"*");
    status=412;
    await assert.rejects(store.put("games.json",Buffer.from('[]'),{ifMatch:'"stale"'}),{status:412});
  } finally {store.close();}
});
