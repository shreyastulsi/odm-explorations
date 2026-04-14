import type { Locator, Page } from "playwright";
import type { UiTarget } from "@nigs/core";

export function describeTarget(target: UiTarget): string {
  return (
    target.css ??
    target.label ??
    target.text ??
    target.placeholder ??
    [target.role, target.name].filter(Boolean).join(":")
  );
}

export function resolveLocator(page: Page, target: UiTarget): Locator {
  let locator: Locator;

  if (target.role) {
    locator = page.getByRole(
      target.role as Parameters<Page["getByRole"]>[0],
      target.name ? { name: target.name } : {}
    );
  } else if (target.label) {
    locator = page.getByLabel(target.label, { exact: false });
  } else if (target.placeholder) {
    locator = page.getByPlaceholder(target.placeholder, { exact: false });
  } else if (target.text) {
    locator = page.getByText(target.text, { exact: false });
  } else if (target.css) {
    locator = page.locator(target.css);
  } else {
    throw new Error("Unsupported target.");
  }

  return locator.nth(target.nth ?? 0);
}
