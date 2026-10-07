// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import { handleCaughtError } from './handle-caught-error.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
    parserOptions: { ecmaFeatures: { globalReturn: true } },
  },
});

ruleTester.run('handle-caught-error', handleCaughtError, {
  valid: [
    'try { f(); } catch (err) { logger.warn({ err }, "f failed"); }',
    'try { f(); } catch (err) { throw new Error("f failed", { cause: err }); }',
    'try { f(); } catch (err) { if (isTimeout(err)) return null; throw err; }',
    'try { f(); } catch (err) { setMessage(getErrorMessage(err, t)); }',
    'try { f(); } catch ({ message }) { log(message); }',
    'try { f(); } catch (err) { setTimeout(() => report(err)); }',
    'try { f(); } catch {\n  // fail-open: storage is unavailable in private mode\n}',
    'try { f(); } catch {\n  // fail-open: an unreachable mirror falls back to the next one\n  next();\n}',
    'try { f(); } catch {\n  /* fail-open: probe only, the caller handles absence */\n  return null;\n}',
  ],
  invalid: [
    { code: 'try { f(); } catch {}', errors: [{ messageId: 'noBinding' }] },
    { code: 'try { f(); } catch { return null; }', errors: [{ messageId: 'noBinding' }] },
    {
      code: 'try { f(); } catch {\n  // ignore errors\n}',
      errors: [{ messageId: 'noBinding' }],
    },
    {
      code: 'try { f(); } catch (err) { return null; }',
      errors: [{ messageId: 'unusedBinding', data: { name: 'err' } }],
    },
    { code: 'try { f(); } catch (_e) {}', errors: [{ messageId: 'unusedBinding' }] },
    { code: 'try { f(); } catch (err) { void err; }', errors: [{ messageId: 'unusedBinding' }] },
    {
      code: 'try { f(); } catch {\n  // fail-open:\n}',
      errors: [{ messageId: 'markerWithoutReason' }],
    },
    {
      code: 'try { f(); } catch {\n  // fail-open: ok\n}',
      errors: [{ messageId: 'markerWithoutReason' }],
    },
    {
      code: '// fail-open: a marker outside the catch block does not count\ntry { f(); } catch {}',
      errors: [{ messageId: 'noBinding' }],
    },
  ],
});
