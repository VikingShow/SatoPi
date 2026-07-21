import { render, type RenderOptions } from "@testing-library/react";
import { type ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n";

/** Custom render that wraps components with required providers (i18n, etc.) */
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    ),
    ...options,
  });
}

/** Mock intersection observer for virtual scrolling tests */
export function mockIntersectionObserver() {
  const mock = {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
    takeRecords: vi.fn(() => []),
  };
  global.IntersectionObserver = vi.fn(() => mock) as any;
  return mock;
}

/** Mock resize observer for layout-dependent components */
export function mockResizeObserver() {
  const mock = {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
  global.ResizeObserver = vi.fn(() => mock) as any;
  return mock;
}
