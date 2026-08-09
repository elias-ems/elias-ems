import { useLocation } from "@remix-run/react";

function linkStyle(isActive) {
  return {
    padding: "0.5rem 1rem",
    textDecoration: "none",
    color: isActive ? "#1f2933" : "#52606d",
    fontWeight: isActive ? "bold" : "normal",
    borderBottom: isActive ? "2px solid #1f2933" : "2px solid transparent",
  };
}

export default function Nav({ ingressPath }) {
  const { pathname } = useLocation();

  return (
    <nav
      style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0 1rem",
        borderBottom: "1px solid #e4e7eb",
        fontFamily: "sans-serif",
      }}
    >
      <a href={`${ingressPath}/`} style={linkStyle(pathname === "/")}>
        Home
      </a>
      <a href={`${ingressPath}/settings`} style={linkStyle(pathname === "/settings")}>
        Settings
      </a>
    </nav>
  );
}
