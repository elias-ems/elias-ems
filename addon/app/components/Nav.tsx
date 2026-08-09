import type { CSSProperties } from "react";
import { NavLink } from "react-router";

const linkStyle = ({ isActive }: { isActive: boolean }): CSSProperties => ({
  padding: "0.5rem 1rem",
  textDecoration: "none",
  color: isActive ? "#1f2933" : "#52606d",
  fontWeight: isActive ? "bold" : "normal",
  borderBottom: isActive ? "2px solid #1f2933" : "2px solid transparent",
});

export default function Nav() {
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
      <NavLink to="/" end style={linkStyle}>
        Home
      </NavLink>
      <NavLink to="/settings" style={linkStyle}>
        Settings
      </NavLink>
    </nav>
  );
}
