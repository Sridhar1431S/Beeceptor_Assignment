/**
 * End-to-end Beeceptor callout-rule automation.
 * Reuses or creates an endpoint, validates synchronous and asynchronous
 * callout behavior, and optionally cleans up the endpoint.
 */

const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');

const BASE = 'https://app.beeceptor.com';
const AUTH_FILE = 'auth.json';
const ENDPOINT_NAME = process.env.BEECEPTOR_ENDPOINT_NAME || 'source-test';
const CLEANUP_ENDPOINT = process.env.BEECEPTOR_CLEANUP_ENDPOINT === 'true';

const TRIGGER_PATH = '/trigger';
// Beeceptor callouts must target an external service, not the same endpoint.
const EXTERNAL_TARGET_URL = 'https://postman-echo.com/post';
const PAYLOAD = { orderId: 'ORD-12345', amount: 499.5 };

/**
 * Normalize the echoed payload from the external echo target.
 */
function extractEchoedPayload(body) {
  if (!body) return null;
  if (body.json && typeof body.json === 'object') return body.json;
  if (body.data !== undefined) {
    if (typeof body.data === 'object') return body.data;
    if (typeof body.data === 'string') {
      try {
        return JSON.parse(body.data);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Fire the trigger request, retrying transient external 5xx errors.
 */
async function fireTrigger(host) {
  const api = await pwRequest.newContext();
  try {
    let lastStatus, lastBody;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await api.post(`https://${host}${TRIGGER_PATH}`, { data: PAYLOAD });
      lastStatus = res.status();
      lastBody = await res.json().catch(() => null);

      const isTransientExternalError = lastStatus >= 500 && lastStatus < 550; // real HTTP 5xx, not Beeceptor's own synthetic 550-599 range
      if (!isTransientExternalError || attempt === 3) {
        return { status: lastStatus, body: lastBody };
      }
      await new Promise(r => setTimeout(r, 1_000 * attempt));
    }
    return { status: lastStatus, body: lastBody };
  } finally {
    await api.dispose();
  }
}

test.use({
  storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
});

test.describe.configure({ mode: 'serial' });

// Shared across both tests in this file (same worker, serial mode).
const ctx = {
  endpointId: null,
  host: null,
  endpointCreated: false,
  ruleCreated: false,
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Close support chat widget if present. */
async function closeChatIfPresent(page) {
  await page.getByRole('button', { name: 'Close chat' }).click({ timeout: 2_000 }).catch(() => {});
}

/** Verify the saved auth session is still valid. */
async function ensureLoggedIn(page) {
  await page.goto(`${BASE}/`);

  if (/\/login/.test(page.url())) {
    throw new Error(
      `Not authenticated (redirected to /login). ${AUTH_FILE} is missing or expired.\n` +
      `Run:\n  npx playwright codegen --channel=chrome --save-storage=${AUTH_FILE} https://app.beeceptor.com\n` +
      `Log in by hand (email + OTP), close the window, and re-run this test.`
    );
  }

  const is404 = await page.getByText('404', { exact: true }).isVisible({ timeout: 3_000 }).catch(() => false);
  if (is404) {
    throw new Error(
      `Landed on a 404 page after navigating to ${BASE}/ (current URL: ${page.url()}). ` +
      `The dashboard root route differs from what this script assumes — open ` +
      `${BASE}/ manually while logged in, note the actual URL the dashboard ` +
      `lands on, and update ensureLoggedIn() to navigate there instead.`
    );
  }

  await closeChatIfPresent(page);
}

/** Open the profile menu if the Endpoints link is hidden. */
async function openProfileMenuIfNeeded(page) {
  const endpointsLink = page.getByRole('link', { name: 'Endpoints' });
  if (await endpointsLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
    return; // already visible, no menu to open
  }

  const profileTrigger = page.getByRole('button', { name: /^user-avatar/i });

  if (await profileTrigger.count() > 0) {
    await profileTrigger.click().catch(() => {});
    await endpointsLink.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  }
}

/**
 * Goes to the Endpoints listing and either reuses an existing endpoint
 * (matching ENDPOINT_NAME if provided, else the first one found) or
 * creates a new free one. Returns { endpointId, host, created }.
 */
async function ensureEndpoint(page) {
  await openProfileMenuIfNeeded(page);
  await page.getByRole('link', { name: 'Endpoints' }).click();
  await closeChatIfPresent(page);

  const endpointLinks = page.getByRole('link', { name: /^#/ });
  const count = await endpointLinks.count();

  if (count > 0) {
    const named = page.getByRole('link', { name: new RegExp(`^#${escapeRegExp(ENDPOINT_NAME)}$`) });
    const target = (await named.count()) > 0 ? named.first() : endpointLinks.first();
    await target.click();
  } else {
    await page.getByRole('link', { name: /Create Free/ }).click();
    await page.getByRole('textbox', { name: 'payments-api' }).fill(ENDPOINT_NAME);
    await page.getByRole('button', { name: /Create Mock Server/ }).click();
    ctx.endpointCreated = true;
  }

  await page.waitForURL(/\/console\//, { timeout: 15_000 });
  const match = page.url().match(/\/console\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error(`Could not extract endpoint id from URL: ${page.url()}`);
  }
  const endpointId = match[1];
  return { endpointId, host: `${endpointId}.free.beeceptor.com`, created: ctx.endpointCreated };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Open the Mock Rules panel from a fresh page state. */
async function openMockRules(page) {
  await page.reload({ waitUntil: 'load' });
  await closeChatIfPresent(page);

  await page.locator('a').filter({ hasText: /^Mock Rules/ }).click();
  const modal = page.locator('.modal.allRules.show');
  await modal.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

  await Promise.race([
    page.getByRole('button', { name: 'Edit rule' }).first().waitFor({ state: 'visible', timeout: 15_000 }),
    page.getByRole('button', { name: 'Toggle Dropdown' }).first().waitFor({ state: 'visible', timeout: 15_000 }),
  ]).catch(() => {
    // Neither appeared in time — don't fail here. Let the caller's own
    // next action surface a specific, actionable error instead of a
    // vague timeout inside this helper.
  });
}

/** Find matching rule rows for the given path. */
async function findRuleRows(page, path) {
  const buttons = page.getByRole('button', { name: 'Edit rule' });
  const total = await buttons.count();
  const rows = [];

  for (let i = 0; i < total; i++) {
    const button = buttons.nth(i);
    // Smallest ancestor div that contains THIS SPECIFIC button (not
    // just any "Edit rule" button) and also mentions the target path —
    // i.e. this one rule's own card, never a bigger multi-rule wrapper.
    const card = page.locator('div')
      .filter({ has: button })
      .filter({ hasText: path })
      .last();

    if (await card.count() > 0) {
      rows.push({ row: card, button });
    }
  }

  return rows;
}

/** Warn if multiple matching rules exist. */
async function warnIfDuplicateRules(rows, path) {
  if (rows.length > 1) {
    const msg =
      `Found ${rows.length} rule rows matching "${path}" on this endpoint — ` +
      `likely duplicates from earlier runs or manual testing. Beeceptor uses ` +
      `first-match-wins rule evaluation, so this script edits the FIRST ` +
      `(highest-priority, actually-live) match; the rest are dead weight. ` +
      `Consider manually deleting the extras in the Beeceptor dashboard so ` +
      `only one "${path}" rule remains.`;
    console.warn(msg);
    try {
      test.info().annotations.push({ type: 'warning', description: msg });
    } catch {
      // Not inside a running test/hook — ignore, console.warn above still ran.
    }
  }
}

/**
 * Ensures a callout rule matching POST /trigger exists, pointed at an
 * external echo service (EXTERNAL_TARGET_URL) rather than this
 * endpoint's own /data — Beeceptor rejects/breaks self-referencing
 * callouts (confirmed manually). Reuses the rule if already present;
 * otherwise creates it from scratch. Returns { created }.
 */
async function ensureTriggerRule(page) {
  const desiredTarget = EXTERNAL_TARGET_URL;
  const rows = await waitForRuleRows(page, TRIGGER_PATH);
  await warnIfDuplicateRules(rows, TRIGGER_PATH);

  if (rows.length > 0) {
    await rows[0].button.click();

    const targetField = page.getByRole('textbox', { name: 'https://your-webhook-endpoint' });
    const currentTarget = await targetField.inputValue().catch(() => null);

    if (currentTarget !== desiredTarget) {
      await targetField.fill(desiredTarget);
      await page.getByRole('button', { name: 'Save' }).click();
    } else {
      await page.getByRole('button', { name: 'Close' }).click({ timeout: 3_000 }).catch(() => {});
    }

    return { created: false };
  }

  await page.getByRole('button', { name: 'Toggle Dropdown' }).click();
  await page.getByRole('link', { name: /New Callout Rule/ }).click();

  // Match: POST /trigger
  await page.getByRole('combobox').first().selectOption('POST');

  const pathField = page.getByRole('textbox', { name: 'e.g. /api/path' });
  await pathField.waitFor({ state: 'visible', timeout: 10_000 });
  await pathField.fill(TRIGGER_PATH);
  const pathValue = await pathField.inputValue().catch(() => null);
  if (pathValue !== TRIGGER_PATH) {
    throw new Error(
      `Path field shows "${pathValue}" after fill(), expected "${TRIGGER_PATH}". ` +
      `The "New Callout Rule" form may not have finished rendering before we ` +
      `interacted with it.`
    );
  }

  // Callout: POST <external echo service>
  await page.getByRole('combobox').nth(3).selectOption('POST');

  await page.locator('#v2CollapseTwo').getByText('Target endpoint').click({ timeout: 3_000 }).catch(() => {});

  const targetFieldNew = page.getByRole('textbox', { name: 'https://your-webhook-endpoint' });
  await targetFieldNew.fill(desiredTarget);
  const targetValue = await targetFieldNew.inputValue().catch(() => null);
  if (targetValue !== desiredTarget) {
    throw new Error(
      `Callout target field shows "${targetValue}" after fill(), expected "${desiredTarget}".`
    );
  }

  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Close' }).click({ timeout: 3_000 }).catch(() => {});

  const created = await waitForRuleRows(page, TRIGGER_PATH);
  if (created.length === 0) {
    throw new Error(
      `Rule row matching "${TRIGGER_PATH}" was not found after save. ` +
      `The rule may have failed validation or not persisted correctly.`
    );
  }

  ctx.ruleCreated = true;
  return { created: true };
}

/** Retry rule lookup to tolerate backend propagation lag. */
async function waitForRuleRows(page, path, { retries = 6, delayMs = 4_000 } = {}) {
  let rows = [];
  for (let attempt = 1; attempt <= retries; attempt++) {
    await openMockRules(page);
    rows = await findRuleRows(page, path);
    if (rows.length > 0) return rows;
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return rows;
}

/** Set the /trigger rule behavior and save it. */
async function setTriggerBehavior(page, value) {
  const rows = await waitForRuleRows(page, TRIGGER_PATH);
  if (rows.length === 0) {
    throw new Error(
      `No rule row found matching "${TRIGGER_PATH}" after retrying — was it ` +
      `deleted externally, or does it genuinely not exist?`
    );
  }
  await rows[0].button.click();

  await page.locator('#v2CollapseOne').getByRole('combobox').selectOption(value);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Close' }).click({ timeout: 3_000 }).catch(() => {});

  const verifyRows = await waitForRuleRows(page, TRIGGER_PATH, { retries: 3, delayMs: 2_000 });
  if (verifyRows.length > 0) {
    await verifyRows[0].button.click();
    const currentValue = await page.locator('#v2CollapseOne').getByRole('combobox')
      .inputValue().catch(() => null);
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 3_000 }).catch(() => {});

    if (currentValue !== value) {
      console.warn(
        `Behavior select shows "${currentValue}" after save/reload, expected "${value}" ` +
        `— the save may not have fully propagated yet.`
      );
    }
  }

  await page.waitForTimeout(3_000);
}

/** Delete the /trigger rule if present. */
async function deleteTriggerRule(page) {
  const rows = await waitForRuleRows(page, TRIGGER_PATH, { retries: 2, delayMs: 1_000 });
  if (rows.length === 0) return;

  page.once('dialog', dialog => dialog.accept().catch(() => {}));
  await rows[0].row.getByRole('button', { name: 'Delete rule' }).click();
}

/** Delete the endpoint if cleanup is enabled. */
async function deleteEndpoint(page) {
  await page.getByRole('link', { name: 'Endpoints' }).click();
  page.once('dialog', dialog => dialog.accept().catch(() => {}));
  await page.getByRole('button', { name: 'Delete free endpoint' }).click({ timeout: 5_000 }).catch(() => {});
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

test.describe('Beeceptor HTTP Callout Rule — verified end-to-end', () => {
  test.setTimeout(120_000);
  let browserContext;
  let page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);

    if (!fs.existsSync(AUTH_FILE)) {
      throw new Error(
        `Missing ${AUTH_FILE}. Run:\n` +
        `  npx playwright codegen --channel=chrome --save-storage=${AUTH_FILE} https://app.beeceptor.com\n` +
        `Log in manually (email + OTP), then close it, and re-run this test.`
      );
    }

    browserContext = await browser.newContext({ storageState: AUTH_FILE });
    page = await browserContext.newPage();

    await ensureLoggedIn(page);

    const endpoint = await ensureEndpoint(page);
    ctx.endpointId = endpoint.endpointId;
    ctx.host = endpoint.host;

    await ensureTriggerRule(page);
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    if (page) {
      if (ctx.ruleCreated) {
        await deleteTriggerRule(page).catch(() => {});
      }
      if (CLEANUP_ENDPOINT && ctx.endpointCreated) {
        await deleteEndpoint(page).catch(() => {});
      }
      await page.close();
    }
    if (browserContext) {
      await browserContext.close();
    }
  });

  test('Synchronous mode: trigger response is relayed from the callout target', async () => {
    await test.step('Set response behavior to synchronous', async () => {
      await setTriggerBehavior(page, 'sync');
    });

    let status, body;
    await test.step('Fire POST /trigger as a real client request', async () => {
      ({ status, body } = await fireTrigger(ctx.host));
    });

    await test.step('Assert response was relayed from the callout target', async () => {
      if (status >= 550 && status <= 599) {
        throw new Error(
          `Got status ${status}, which is in Beeceptor's own synthetic error ` +
          `range (550-599) — this means the CALLOUT ITSELF failed (network/DNS/SSL ` +
          `issue reaching the target), not that the target returned an unusual response. ` +
          `Check the rule's configured callout target in the Beeceptor dashboard — it ` +
          `should be exactly "${EXTERNAL_TARGET_URL}". Response body: ${JSON.stringify(body)}`
        );
      }
      expect(status).toBe(200);
      expect(extractEchoedPayload(body)).toEqual(PAYLOAD);
    });
  });

  test('Asynchronous mode: trigger returns an instant mock response immediately', async () => {
    await test.step('Switch response behavior to asynchronous', async () => {
      await setTriggerBehavior(page, 'async');
    });

    let status, body;
    await test.step('Fire POST /trigger and capture the immediate response', async () => {
      ({ status, body } = await fireTrigger(ctx.host));
    });

    await test.step('Assert instant mock response in async mode', async () => {
      expect(status).toBe(200);
      expect(extractEchoedPayload(body)).not.toEqual(PAYLOAD);
    });

    await test.step('Known limitation (documented, not faked)', async () => {
      test.info().annotations.push({
        type: 'known-limitation',
        description:
          'Independently confirming the background callout to /data actually ' +
          'landed in async mode requires Beeceptor\'s request-log feature, ' +
          'which is paywalled on the free tier. This test verifies the ' +
          'documented client-facing contract of async mode (instant response, ' +
          'distinct from the relayed callout result) instead. The sync-mode ' +
          'test above provides callout-execution proof via response relay.',
      });
    });
  });
});
