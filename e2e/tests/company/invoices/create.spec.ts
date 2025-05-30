import { db, takeOrThrow } from "@test/db";
import { companiesFactory } from "@test/factories/companies";
import { companyContractorsFactory } from "@test/factories/companyContractors";
import { companyInvestorsFactory } from "@test/factories/companyInvestors";
import { companyRolesFactory } from "@test/factories/companyRoles";
import { equityAllocationsFactory } from "@test/factories/equityAllocations";
import { equityGrantsFactory } from "@test/factories/equityGrants";
import { usersFactory } from "@test/factories/users";
import { login } from "@test/helpers/auth";
import { expect, test } from "@test/index";
import { subDays } from "date-fns";
import { desc, eq } from "drizzle-orm";
import { PayRateType } from "@/db/enums";
import { companies, companyContractors, companyInvestors, invoices, users } from "@/db/schema";

test.describe("invoice creation", () => {
  let company: typeof companies.$inferSelect;
  let contractorUser: typeof users.$inferSelect;
  let companyInvestor: typeof companyInvestors.$inferSelect;
  let companyContractor: typeof companyContractors.$inferSelect;
  let projectBasedUser: typeof users.$inferSelect;

  test.beforeEach(async () => {
    // Create company with equity compensation enabled
    company = (
      await companiesFactory.createCompletedOnboarding({
        equityCompensationEnabled: true,
      })
    ).company;

    // Create contractor user with business info
    contractorUser = (
      await usersFactory.createWithBusinessEntity({
        zipCode: "22222",
        streetAddress: "1st St.",
      })
    ).user;

    // Set up equity investment
    companyInvestor = (
      await companyInvestorsFactory.create({
        companyId: company.id,
        userId: contractorUser.id,
      })
    ).companyInvestor;
    await equityGrantsFactory.createActive(
      { companyInvestorId: companyInvestor.id, sharePriceUsd: "1" },
      { year: 2023 },
    );

    // Create contractor with hourly rate and equity allocation
    companyContractor = (
      await companyContractorsFactory.create({
        companyId: company.id,
        userId: contractorUser.id,
        payRateInSubunits: 6000, // $60/hr
        payRateType: PayRateType.Hourly,
      })
    ).companyContractor;
    await equityAllocationsFactory.create({
      companyContractorId: companyContractor.id,
      equityPercentage: 20,
      year: 2023,
    });

    const { role: projectBasedRole } = await companyRolesFactory.createProjectBased({ companyId: company.id });
    projectBasedUser = (
      await usersFactory.createWithBusinessEntity({
        zipCode: "33333",
        streetAddress: "2nd Ave.",
      })
    ).user;

    const { companyInvestor: projectBasedInvestor } = await companyInvestorsFactory.create({
      companyId: company.id,
      userId: projectBasedUser.id,
    });
    await equityGrantsFactory.createActive(
      { companyInvestorId: projectBasedInvestor.id, sharePriceUsd: "1.5" },
      { year: 2023 },
    );

    const { companyContractor: projectBasedContractor } = await companyContractorsFactory.createProjectBased({
      companyId: company.id,
      userId: projectBasedUser.id,
      companyRoleId: projectBasedRole.id,
      payRateInSubunits: 1_000_00, // $1,000/project
    });
    await equityAllocationsFactory.create({
      companyContractorId: projectBasedContractor.id,
      equityPercentage: 50,
      year: 2023,
    });
  });

  test("creates an invoice with an equity component", async ({ page }) => {
    await login(page, contractorUser);
    await page.goto("/invoices/new");

    await page.getByLabel("Hours").fill("3:25");
    await page.getByPlaceholder("Description").fill("I worked on invoices");
    await page.getByLabel("Date").fill("2023-08-08");

    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Total services
      - text: $205
    `);
    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Swapped for equity (not paid in cash)
      - text: $41
    `);
    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Net amount in cash
      - text: $164
    `);

    await page.getByRole("button", { name: "Send invoice" }).click();

    await expect(page.getByText("Lock 20% in equity for all 2023?")).toBeVisible();
    await expect(
      page.getByText("By submitting this invoice, your current equity selection of 20% will be locked for all 2023."),
    ).toBeVisible();
    await expect(
      page.getByText("You won't be able to choose a different allocation until the next options grant for 2024"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Change selection" })).toHaveAttribute("href", `/settings/equity`);

    await page.getByRole("button", { name: "Confirm 20% equity selection" }).click();
    await expect(page.locator("tbody")).toContainText(
      [
        "Invoice ID",
        "1",
        "Sent on",
        "Aug 8, 2023",
        "Hours",
        "03:25",
        "Amount",
        "$205",
        "Status",
        "Awaiting approval (0/2)",
      ].join(""),
    );

    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);
    expect(invoice).toBeDefined();
    expect(invoice.totalMinutes).toBe(205);
    expect(invoice.totalAmountInUsdCents).toBe(20500n);
    expect(invoice.cashAmountInCents).toBe(16400n);
    expect(invoice.equityAmountInCents).toBe(4100n);
    expect(invoice.equityPercentage).toBe(20);
  });

  test("creates an invoice with an equity component for a project-based contractor", async ({ page }) => {
    await login(page, projectBasedUser);
    await page.goto("/invoices/new");

    await page.getByPlaceholder("Description").fill("Website redesign project");
    await page.getByLabel("Amount").fill("1000");
    await page.getByLabel("Date").fill("2023-08-08");

    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Total services
      - text: $1,000
    `);
    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Swapped for equity (not paid in cash)
      - text: $500
    `);
    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Net amount in cash
      - text: $500
    `);

    await page.getByRole("button", { name: "Send invoice" }).click();

    await expect(page.getByText("Lock 50% in equity for all 2023?")).toBeVisible();
    await page.getByRole("button", { name: "Confirm 50% equity selection" }).click();

    await expect(page.locator("tbody")).toContainText(
      ["Invoice ID", "1", "Sent on", "Aug 8, 2023", "Amount", "$1,000", "Status", "Awaiting approval (0/2)"].join(""),
    );

    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);
    expect(invoice).toBeDefined();
    expect(invoice.totalAmountInUsdCents).toBe(100000n);
    expect(invoice.cashAmountInCents).toBe(50000n);
    expect(invoice.equityAmountInCents).toBe(50000n);
    expect(invoice.equityPercentage).toBe(50);
  });

  test("considers the invoice year when calculating equity", async ({ page }) => {
    await equityGrantsFactory.createActive(
      {
        companyInvestorId: companyInvestor.id,
        sharePriceUsd: "300",
      },
      { year: 2021 },
    );
    await equityAllocationsFactory.create({
      companyContractorId: companyContractor.id,
      equityPercentage: 20,
      year: 2021,
      locked: true,
      status: "approved",
    });

    await login(page, contractorUser);
    await page.goto("/invoices/new");

    await page.getByLabel("Hours").fill("03:25");
    await page.getByPlaceholder("Description").fill("I worked on invoices");
    await page.getByLabel("Date").fill("2021-08-08");

    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Total
      - text: $205
    `);
    await expect(page.getByText("Swapped for equity")).not.toBeVisible();
    await expect(page.getByText("Net amount in cash")).not.toBeVisible();

    await page.getByLabel("Hours").fill("100:00");
    await page.getByPlaceholder("Description").fill("I worked on invoices");

    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Total services
      - text: $6,000
    `);
    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Swapped for equity (not paid in cash)
      - text: $1,200
    `);
    await expect(page.locator("footer")).toMatchAriaSnapshot(`
      - strong: Net amount in cash
      - text: $4,800
    `);

    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.locator("tbody")).toContainText(
      [
        "Invoice ID",
        "1",
        "Sent on",
        "Aug 8, 2021",
        "Hours",
        "100:00",
        "Amount",
        "$6,000",
        "Status",
        "Awaiting approval (0/2)",
      ].join(""),
    );

    const invoice = await db.query.invoices
      .findFirst({
        orderBy: desc(invoices.id),
      })
      .then(takeOrThrow);
    expect(invoice.totalMinutes).toBe(6000);
    expect(invoice.totalAmountInUsdCents).toBe(600000n);
    expect(invoice.cashAmountInCents).toBe(480000n);
    expect(invoice.equityAmountInCents).toBe(120000n);
    expect(invoice.equityPercentage).toBe(20);
  });

  test("allows creation of an invoice as an alumni", async ({ page }) => {
    await db
      .update(companyContractors)
      .set({ startedAt: subDays(new Date(), 365), endedAt: subDays(new Date(), 100) })
      .where(eq(companyContractors.id, companyContractor.id));

    await login(page, contractorUser);
    await page.goto("/invoices/new");
    await page.getByPlaceholder("Description").fill("item name");
    await page.getByPlaceholder("HH:MM").fill("01:00");
    await page.getByPlaceholder("Enter notes about your").fill("sent as alumni");
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.getByRole("cell", { name: "Awaiting approval (0/2)" })).toBeVisible();
  });
});
