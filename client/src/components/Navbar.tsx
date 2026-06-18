import { useState } from 'react';
import { NavLink } from 'react-router-dom';

const navItems = [
  { label: 'Daily Brief', to: '/', end: true },
  { label: 'Following', to: '/following' },
  { label: 'Archive', to: '#' },
  { label: 'Settings', to: '#' },
];

function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  const getLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? 'font-label text-sm leading-[1.4] font-medium text-primary border-b-2 border-primary pb-1 transition-opacity'
      : 'font-label text-sm leading-[1.4] font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container-low transition-colors duration-200 px-1 py-1 rounded';

  return (
    <>
      <header className="bg-background border-b border-outline-variant w-full sticky top-0 z-50">
        <div className="flex justify-between items-center w-full px-margin-mobile md:px-margin-desktop max-w-container-max mx-auto h-16">
          {/* Brand */}
          <NavLink
            to="/"
            className="font-display text-[48px] leading-[1.1] font-bold text-primary"
          >
            Narrative
          </NavLink>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-gutter">
            {navItems.map((item) => (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.end}
                className={getLinkClass}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Desktop Account */}
          <div className="hidden md:flex items-center">
            <button
              className="text-primary p-1 hover:bg-surface-container-low rounded-full transition-colors duration-200"
              aria-label="Account"
            >
              <span className="material-symbols-outlined">account_circle</span>
            </button>
          </div>

          {/* Mobile Hamburger */}
          <button
            className="md:hidden text-primary p-2 hover:bg-surface-container-low rounded-full transition-colors duration-200"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed top-0 right-0 h-full w-64 bg-background z-50 shadow-lg flex flex-col p-6">
            <button
              className="self-end text-primary p-2 hover:bg-surface-container-low rounded-full transition-colors duration-200"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
            <nav className="flex flex-col gap-4 mt-4">
              {navItems.map((item) => (
                <NavLink
                  key={item.label}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMobileOpen(false)}
                  className={getLinkClass}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-auto pt-4">
              <button
                className="text-primary p-1 hover:bg-surface-container-low rounded-full transition-colors duration-200"
                aria-label="Account"
              >
                <span className="material-symbols-outlined">
                  account_circle
                </span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default Navbar;
