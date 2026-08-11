/**
 * The add-on's top bar: its name, then its pages.
 *
 * This is the bar ESPHome and the Matter server appear to add to Home
 * Assistant's chrome. They don't — HA renders an ingress panel as a bare
 * cross-origin iframe with no toolbar of its own above it, and gives the add-on
 * no way to put anything in HA's. What those add-ons do is render a Material
 * top app bar as the first thing inside their own iframe, which is what this
 * is, styled to sit continuously with the HA page it is embedded in.
 */
import type { CSSProperties } from "react";
import { NavLink } from "react-router";

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  // Matches the height of Home Assistant's own app bar, so the add-on's bar
  // lines up with HA's when HA shows one (narrow layouts, where the panel gets
  // a header with the sidebar's menu button).
  height: 64,
  padding: "0 1rem",
  background: "var(--color-header-bg)",
  color: "var(--color-header-text)",
  // Above the autocomplete's suggestion popover, which sits at 10.
  position: "sticky",
  top: 0,
  zIndex: 20,
};

const titleStyle: CSSProperties = {
  // Pushes the links to the far end of the bar.
  marginRight: "auto",
  fontSize: "1.25rem",
  fontWeight: 600,
};

const navStyle: CSSProperties = {
  display: "flex",
  alignSelf: "stretch",
};

/**
 * A tab in the bar, underlined when it is the page you're on. The indicator is
 * an inset shadow rather than a border so that switching pages doesn't move the
 * label by the three pixels the border would occupy.
 */
const linkStyle = ({ isActive }: { isActive: boolean }): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  padding: "0 1rem",
  color: "var(--color-header-text)",
  textDecoration: "none",
  fontWeight: isActive ? 700 : 500,
  boxShadow: isActive ? "inset 0 -3px 0 var(--color-header-text)" : "none",
});

export default function AppHeader() {
  return (
    <header className="app-header" style={headerStyle}>
      <span style={titleStyle}>Elias ems</span>
      <nav style={navStyle}>
        <NavLink to="/" end style={linkStyle}>
          Home
        </NavLink>
        <NavLink to="/settings" style={linkStyle}>
          Settings
        </NavLink>
      </nav>
    </header>
  );
}
