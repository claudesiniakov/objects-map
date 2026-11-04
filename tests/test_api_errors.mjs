import assert from 'node:assert/strict';
import { test } from 'node:test';
Object.defineProperty(globalThis, 'localStorage', {value: {getItem: () => null}});
const {request, ApiError} = await import('../static/js/api.js');

test('structured rollback refusal reaches the operator without exposing snapshots', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({detail: {
    code: 'rollback_conflict', message: 'Откат отменён: данные изменились после импорта',
    count: 2, conflicts: [{object_id: 1, reason: 'changed_after_import'}],
  }}), {status: 409, headers: {'Content-Type': 'application/json'}});
  await assert.rejects(request('POST', '/api/import/1/rollback', {}), e =>
    e instanceof ApiError && e.status === 409 && e.message === 'Откат отменён: данные изменились после импорта');
});

test('legacy string and validation errors remain readable', async () => {
  for (const detail of ['Нет доступа', [{loc: ['body', 'name'], msg: 'Required'}]]) {
    globalThis.fetch = async () => new Response(JSON.stringify({detail}), {status: 422});
    await assert.rejects(request('POST', '/api/objects', {}), e =>
      e.message === (typeof detail === 'string' ? detail : 'name: Required'));
  }
});
