/**
 * Shared HTML layout for the Flair web admin.
 * Server-rendered, no JS framework. Minimal CSS for Nathan-grade UX.
 */

const VERSION = process.env.npm_package_version ?? "dev";

export function layout(title: string, content: string, activePage?: string): string {
  const nav = [
    { href: "/AdminDashboard", label: "Home", id: "home" },
    { href: "/AdminMemory", label: "Memory", id: "memory" },
    { href: "/AdminPrincipals", label: "Principals", id: "principals" },
    { href: "/AdminConnectors", label: "Connectors", id: "connectors" },
    { href: "/AdminIdp", label: "IdP", id: "idp" },
    { href: "/AdminInstance", label: "Instance", id: "instance" },
  ];

  const navHtml = nav.map(n =>
    `<a href="${n.href}" class="nav-item${activePage === n.id ? " active" : ""}">${n.label}</a>`
  ).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Flair Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #1a1a1a; }
    .layout { display: flex; min-height: 100vh; }
    .sidebar {
      width: 220px; background: #1a1a2e; color: #e0e0e0; padding: 20px 0;
      display: flex; flex-direction: column; flex-shrink: 0;
    }
    .sidebar-brand { padding: 0 20px 20px; font-size: 1.3em; font-weight: 700; color: #fff; border-bottom: 1px solid #2a2a4e; }
    .nav-item {
      display: block; padding: 10px 20px; color: #b0b0c0; text-decoration: none;
      font-size: 0.95em; transition: background 0.15s;
    }
    .nav-item:hover { background: #2a2a4e; color: #fff; }
    .nav-item.active { background: #2563eb; color: #fff; font-weight: 600; }
    .main { flex: 1; padding: 32px 40px; max-width: 1100px; }
    .main h1 { font-size: 1.6em; margin-bottom: 8px; }
    .main .subtitle { color: #666; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th { text-align: left; padding: 12px 16px; background: #f1f3f5; font-size: 0.85em; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 12px 16px; border-top: 1px solid #eee; font-size: 0.95em; }
    tr:hover td { background: #f8f9ff; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; font-weight: 600; }
    .badge-green { background: #d4edda; color: #155724; }
    .badge-gray { background: #e9ecef; color: #495057; }
    .badge-blue { background: #cce5ff; color: #004085; }
    .badge-yellow { background: #fff3cd; color: #856404; }
    .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 16px; }
    .card h3 { font-size: 1.1em; margin-bottom: 8px; }
    .card .value { font-size: 2em; font-weight: 700; color: #2563eb; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .empty { text-align: center; padding: 40px; color: #888; }
    .btn { display: inline-block; padding: 8px 16px; border-radius: 6px; font-size: 0.9em; text-decoration: none; cursor: pointer; border: none; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-danger { background: #dc3545; color: #fff; }
    .footer { padding: 20px; margin-top: auto; font-size: 0.8em; color: #666; border-top: 1px solid #2a2a4e; }
    @media (max-width: 768px) {
      .sidebar { width: 60px; } .sidebar-brand { display: none; } .nav-item { padding: 10px; text-align: center; font-size: 0.8em; }
      .main { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-brand">Flair</div>
      ${navHtml}
      <div class="footer">v${VERSION}</div>
    </nav>
    <main class="main">
      ${content}
    </main>
  </div>
</body>
</html>`;
}

export function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
