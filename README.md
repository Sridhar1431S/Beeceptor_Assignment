# Beeceptor Playwright Automation Assignment

## **Overview**

This project automates the complete Beeceptor HTTP Callout workflow using Playwright (JavaScript). The test is designed to be repeatable by reusing an existing endpoint if available or creating a new one when required.

---

## **Features**

* Opens the Beeceptor dashboard.
* Reuses an existing endpoint or creates a new one.
* Creates an HTTP Callout Rule.
* Configures the callout with the required HTTP method, path, and target URL.
* Triggers the configured endpoint.
* Verifies that the endpoint accepts and processes the trigger request successfully.
* Updates the HTTP Callout behavior from **Synchronous** to **Asynchronous**.
* Deletes the created Callout Rule as part of cleanup.

---

## **Tech Stack**

* JavaScript
* Playwright
* Node.js

---

## **Project Structure**

```text
Beeceptor_Assignment/
│── beeceptor-final.spec.js
│── package.json
│── package-lock.json
│── .gitignore
└── README.md
```

---

## **Prerequisites**

Before running the project, ensure you have:

* Node.js (v18 or later recommended)
* npm
* Playwright installed

---

## **Installation**

Install project dependencies:

```bash
npm install
```

Install Playwright browsers:

```bash
npx playwright install
```

---

## **Execution**

Run the Playwright test:

```bash
npx playwright test
```

Or run the specific test file:

```bash
npx playwright test beeceptor-final.spec.js
```

---

## **Workflow**

The automation performs the following steps:

1. Opens the Beeceptor application.
2. Uses a stored authenticated session.
3. Checks whether the endpoint already exists.
4. Creates a new endpoint if it does not exist.
5. Opens the Mock Rules section.
6. Creates a new HTTP Callout Rule.
7. Configures:

   * HTTP Method: **POST**
   * Endpoint Path: **/trigger**
   * Callout Target: **https://postman-echo.com/post**
8. Triggers the endpoint using a POST request.
9. Verifies that the trigger request completes successfully.
10. Updates the Callout Rule from **Sync** to **Async**.
11. Deletes the Callout Rule to keep the environment clean.

---

## **Authentication**

The project uses a previously generated Playwright authentication state (`auth.json`) to avoid repeated manual logins.

The `auth.json` file is excluded from version control using `.gitignore` and should be generated locally before executing the test.

---

## **Notes**

* The test is designed to be idempotent by reusing an existing endpoint whenever possible.
* A longer timeout is configured to support the complete end-to-end workflow against the live Beeceptor application.
* Cleanup is performed by deleting the created HTTP Callout Rule after execution.

---

## **Author**

**Sridhar Reddy**
