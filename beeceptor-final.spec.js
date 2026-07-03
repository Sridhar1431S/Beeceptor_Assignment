import { test, expect } from '@playwright/test';

test.use({
  storageState: 'auth.json'
});

const ENDPOINT_NAME = 'source-test';
const CALLOUT_TARGET = 'https://postman-echo.com/post';

test('Beeceptor callout rule - create, switch to async, delete', async ({ page }) => {
  // Default Playwright test timeout is 30s — not enough for this whole
  // flow against a live dashboard. Give it real headroom.
  test.setTimeout(180_000);

  // ---------------------------------------------------------------
  // Login + navigate to Endpoints
  // ---------------------------------------------------------------
  await page.goto('https://app.beeceptor.com/');
  await page.getByRole('button', { name: 'user-avatar Sridhar Reddy S' }).click();
  await page.getByRole('link', { name: 'Endpoints' }).click();

  // ---------------------------------------------------------------
  // Reuse vs create: check if "#source-test" already exists in the list
  // ---------------------------------------------------------------
  const existingEndpointLink = page.getByRole('link', { name: `#${ENDPOINT_NAME}` });
  const endpointExists = await existingEndpointLink.isVisible().catch(() => false);

  if (endpointExists) {
    // --- Reuse path ---
    await existingEndpointLink.click();
  } else {
    // --- Create path ---
    await page.getByRole('link', { name: ' Create Free' }).click();
    await page.getByRole('textbox', { name: 'payments-api' }).click();
    await page.getByRole('textbox', { name: 'payments-api' }).fill(ENDPOINT_NAME);
    await page.getByRole('button', { name: ' Create Mock Server' }).click();
  }

  // ---------------------------------------------------------------
  // Open Mock Rules panel
  // ---------------------------------------------------------------
  await page.locator('a').filter({ hasText: 'Mock Rules' }).click();

  // Wait for the modal to actually finish rendering before touching
  // anything inside it.
  await page.locator('.modal.allRules.show').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Toggle Dropdown' }).first().waitFor({ state: 'visible', timeout: 15_000 });

  // ---------------------------------------------------------------
  // Create rule: POST /trigger -> sync callout to postman-echo
  // ---------------------------------------------------------------
  await page.getByRole('button', { name: 'Toggle Dropdown' }).click();
  await page.getByRole('link', { name: ' New Callout Rule' }).click();
  await page.getByRole('combobox').first().selectOption('POST');
  await page.getByRole('textbox', { name: 'e.g. /api/path' }).click();
  await page.getByRole('textbox', { name: 'e.g. /api/path' }).fill('/trigger');
  await page.getByRole('combobox').nth(3).selectOption('POST');
  await page.getByRole('textbox', { name: 'https://your-webhook-endpoint' }).click();
  await page.getByRole('textbox', { name: 'https://your-webhook-endpoint' }).fill(CALLOUT_TARGET);
  await page.getByRole('button', { name: ' Save' }).click();

  // ---------------------------------------------------------------
  // NEW: Verify the HTTP Callout executes successfully with expected behavior
  // ---------------------------------------------------------------
  // Beeceptor's free plan has no Request History/Log panel (that's a
  // Team-plan+ feature), so we can't inspect the callout server-side.
  // Best-effort verification: hit the mock endpoint's /trigger route
  // (this is what actually fires the rule and its callout to
  // CALLOUT_TARGET) and assert Beeceptor accepted and processed it
  // successfully.
  await page.getByRole('button', { name: 'Edit rule' }).first().waitFor({ state: 'visible', timeout: 15_000 });

  const triggerResponse = await page.request.post(`https://${ENDPOINT_NAME}.free.beeceptor.com/trigger`, {
    data: { verification: true, sentAt: Date.now() }
  });
  expect(triggerResponse.ok()).toBeTruthy();
  expect(triggerResponse.status()).toBeLessThan(400);
  // ---------------------------------------------------------------
  // END NEW
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // Edit the same rule: switch behavior to async
  // ---------------------------------------------------------------
  await page.getByRole('button', { name: 'Edit rule' }).click();
  await page.locator('#v2CollapseOne').getByRole('combobox').selectOption('async');
  await page.getByRole('button', { name: ' Save' }).click();

  // ---------------------------------------------------------------
  // Delete the rule
  // ---------------------------------------------------------------
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  await page.getByRole('button', { name: 'Delete rule' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
});
