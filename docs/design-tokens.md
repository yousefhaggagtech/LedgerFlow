## Token ownership

`apps/web/src/app/globals.css` owns the tokens. Tailwind CSS 4 uses CSS-first
`@theme` configuration, so no `tailwind.config.ts` is needed. Semantic CSS
variables are mapped to utilities with `@theme inline`, following the
[shadcn CSS-variable convention](https://ui.shadcn.com/docs/tailwind-v4).
Components use role names such as `bg-card`, `text-muted-foreground`, and
`border-border`; they contain no raw colors or arbitrary pixel dimensions.
The default color utility palette is disabled to keep feature code on tokens.

Only a light palette is implemented. A later theme can override the semantic
variables; no dark styles, toggle, theme provider, or persistence are included.

## Color roles and usage

There is no supplied brand guide. Indigo 600 is the assumed brand primary;
Slate is the neutral family. White surfaces sit on a Slate 50 canvas.

| CSS variable(s) | Value | Use |
| --- | --- | --- |
| `--background` | `#f8fafc` (Slate 50) | Application canvas |
| `--foreground`, `--card-foreground`, `--popover-foreground` | `#0f172a` (Slate 900) | Headings and main text |
| `--card`, `--popover`, `--sidebar` | `#ffffff` | White surfaces |
| `--primary`, `--ring`, `--sidebar-ring` | `#4f46e5` (Indigo 600) | Primary action, active indicator, focus |
| `--primary-hover`, `--accent-foreground`, `--sidebar-accent-foreground` | `#4338ca` (Indigo 700) | Primary hover and active text |
| `--primary-foreground`, `--destructive-foreground` | `#ffffff` | Text on strong controls |
| `--accent`, `--sidebar-accent` | `#eef2ff` (Indigo 50) | Subtle active/hover tint; no heavy nav fill |
| `--secondary`, `--muted` | `#f1f5f9` (Slate 100) | Neutral badges, avatar fallback, muted surfaces |
| `--secondary-foreground` | `#334155` (Slate 700) | Neutral emphasized text |
| `--muted-foreground` | `#64748b` (Slate 500) | Secondary text, descriptions |
| `--sidebar-foreground` | `#475569` (Slate 600) | Inactive navigation |
| `--border`, `--sidebar-border` | `#e2e8f0` (Slate 200) | Surface and separator borders |
| `--input` | `#cbd5e1` (Slate 300) | Input outlines |
| `--destructive` | `#0f172a` (Slate 900) | Neutral emphasis for destructive controls/invalid input |
| `--overlay` | `rgb(15 23 42 / 35%)` | Mobile drawer scrim |
| `--status-paid` / `--status-paid-surface` | `#166534` / `#f0fdf4` | Paid financial state only |
| `--status-overdue` / `--status-overdue-surface` | `#b91c1c` / `#fef2f2` | Overdue financial state only |
| `--status-pending` / `--status-pending-surface` | `#92400e` / `#fffbeb` | Pending financial state only |

Green, red, and amber are reserved for financial states. Never use them for
decoration, AI branding, infrastructure status, or ordinary form validation.
`Badge` exposes `paid`, `overdue`, and `pending` variants for future financial
features. Always include a text label; color alone must not communicate state.
Its default variant uses a subtle Indigo tint, and its `secondary` variant is
neutral. Connectivity uses neutral badges with explicit UP/DOWN/UNKNOWN text.
The shadcn `destructive` role is deliberately Slate to preserve this rule.

## Typography

Inter is loaded through `next/font/google` (Latin subset, variable font,
`display: swap`) and self-hosted in Next.js output. Builds need network access
on the first font download; visitors do not contact Google Fonts. The CSS
stack is Inter, UI sans-serif, system-ui, sans-serif.

| Utility | Size / line height | Use |
| --- | --- | --- |
| `text-xs` | 12 / 16px | Metadata and badges |
| `text-sm` | 14 / 20px | Default UI text and navigation |
| `text-base` | 16 / 24px | Body emphasis; mobile inputs avoid focus zoom |
| `text-lg` | 18 / 28px | Brand and small headings |
| `text-xl` | 20 / 28px | Section headings |
| `text-2xl` | 24 / 32px | Page headings |
| `text-3xl` | 30 / 36px | Available for future prominent headings |

Sizes are defined in rem, with pixel equivalents above at a 16px root.
Use regular (400), medium (500), and semibold (600) weights. Keep paragraphs
left-aligned except deliberate empty states. Financial figures must use the
reusable `tabular-nums` utility (`font-variant-numeric: tabular-nums`), for
example `<span className="tabular-nums">12,450.00</span>`. It changes alignment,
not number formatting or financial precision.

## Spacing and density

`--space-unit: 0.25rem` maps to Tailwind's `--spacing`. Numeric spacing
utilities are multiples of this 4px base, including half steps for small
details. Prefer the following scale:

| Step | rem | px |
| --- | --- | --- |
| 0.5 | 0.125 | 2 |
| 1 | 0.25 | 4 |
| 1.5 | 0.375 | 6 |
| 2 | 0.5 | 8 |
| 3 | 0.75 | 12 |
| 4 | 1 | 16 |
| 5 | 1.25 | 20 |
| 6 | 1.5 | 24 |
| 8 | 2 | 32 |
| 10 | 2.5 | 40 |
| 11 | 2.75 | 44 |
| 12 | 3 | 48 |
| 16 | 4 | 64 |

The shell is comfortable: 44px nav items, 72px navbar, 40px default buttons
and inputs. Main padding is 20px on mobile, 24px from `md`, and 32px from `lg`.
Cards have 24px padding and 24px vertical gaps. Empty-state vertical padding
uses 48px on mobile and 64px from `md`. Borders use Tailwind's 1px `border`.

Compact table tokens are defined but no Table component is installed:
`--table-row-height: 2.25rem` (36px minimum), `--table-cell-x: 0.75rem` (12px),
`--table-cell-y: 0.5rem` (8px). Future tables can use `h-table-row`,
`px-table-cell-x`, and `py-table-cell-y`. Allow rows to grow for wrapped text.

## Radius and shadows

`--radius: 0.5rem` is the base.

| Utility | Radius | Use |
| --- | --- | --- |
| `rounded-xs` | 4px | Small details |
| `rounded-sm` | 6px | Menu items |
| `rounded-md` | 8px | Controls, nav items, tooltips |
| `rounded-lg` | 12px | Supporting surfaces |
| `rounded-xl` | 16px | Cards |
| `rounded-full` | Full rounding | Avatars, badges, active indicator |

| Utility / source token | Shadow | Use |
| --- | --- | --- |
| `shadow-xs` / `--surface-shadow-xs` | `0 1px 2px rgb(15 23 42 / 3%)` | Inputs, outlined controls |
| `shadow-sm` / `--surface-shadow-sm` | `0 1px 3px rgb(15 23 42 / 5%)` | Cards |
| `shadow-md` / `--surface-shadow-md` | `0 4px 12px rgb(15 23 42 / 8%)` | Dropdown |
| `shadow-lg` / `--surface-shadow-lg` | `0 8px 24px rgb(15 23 42 / 10%)` | Drawer |

No gradients or entrance animations. Controls retain simple color/focus
feedback. Sidebar width changes immediately, without motion or layout lag.

## Shell dimensions and responsive behavior

| Source token | Value | Utility / purpose |
| --- | --- | --- |
| `--sidebar-expanded` | 15rem / 240px | `w-sidebar-expanded`; desktop and drawer |
| `--sidebar-collapsed` | 4rem / 64px | `w-sidebar-collapsed`; desktop icon rail |
| `--navbar-height` | 4.5rem / 72px | `h-navbar` |
| `--nav-item-height` | 2.75rem / 44px | `h-nav-item` |
| `--nav-indicator-width` | 0.125rem / 2px | `w-nav-indicator`; active left indicator |
| `--content-width` | 80rem / 1280px | `max-w-content`; responsive main container |
| `--profile-menu-width` | 15rem / 240px | `w-profile-menu` |
| `--menu-min-width` | 8rem / 128px | `min-w-menu-min`; base dropdown minimum |

| Breakpoint token | Value |
| --- | --- |
| `--breakpoint-sm` | 40rem / 640px |
| `--breakpoint-md` | 48rem / 768px |
| `--breakpoint-lg` | 64rem / 1024px |
| `--breakpoint-xl` | 80rem / 1280px |
| `--breakpoint-2xl` | 96rem / 1536px |

Below `md`, the sidebar is hidden. The navbar menu opens a left Sheet at
240px, capped at viewport width, with a dimmed backdrop. Its navigation
scrolls independently on short screens, and the close button remains at the
bottom. It closes on selection, Escape, close button, backdrop click, or
resizing into desktop; focus trapping and restoration come from Radix.

At `md` and above (including 768px tablets), the sidebar starts expanded.
Its keyboard-operable footer toggle switches to a 64px rail. Labels stay
available to assistive technology and tooltips appear on hover/focus, including
the expand control. Collapse state is in-memory and survives server refreshes;
it resets on full reload. Mobile open state is independent of collapse state.

Navigation is grouped as Workspace (Sales, Expenses, Banking, Reports), Tools
(Documents, AI Assistant), and bottom-aligned Settings. All links are local
preview placeholders. Sales starts active; selecting a link changes only the
active indicator and breadcrumb, and closes the mobile drawer. The shared
workspace preview stays in place. No feature routes or business pages exist.

The navbar shows the placeholder organization **Acme Studio**, a
Workspace/selected-section breadcrumb, and the **Demo User** avatar/dropdown.
The name is hidden on narrow screens; the labeled avatar trigger remains.
Profile actions show an explanatory placeholder message without performing
account operations. No authentication, organization switching, or financial
data is implemented.

## Architecture and verification

`src/app/layout.tsx` loads Inter and wraps routes in the client `Layout`
(`src/components/layout/app-shell.tsx`). It accepts server-rendered children;
API requests and `API_URL` remain server-only in `src/app/page.tsx`. Local
shell state contains only preview selection, sidebar collapse, and drawer
visibility. Reusable UI primitives and `src/lib/utils.ts` stay in the web
presentation layer. There are no API, database, schema, or security changes.

Semantics include one `<main>`, a `<header>`, labeled navigation/breadcrumb
landmarks, `aria-current="page"` on the active link, a skip link, visible focus
indicators, and accessible toggle/profile labels. Dropdown items support
arrows/Enter/Escape; the Sheet contains focus and restores its trigger.

