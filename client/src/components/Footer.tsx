function Footer() {
  return (
    <footer className="bg-surface border-t border-outline-variant">
      <div className="w-full py-stack-lg px-margin-mobile md:px-margin-desktop flex flex-col md:flex-row justify-between items-center max-w-container-max mx-auto gap-stack-md">
        <div className="font-label text-label-caps tracking-widest text-primary uppercase">
          The Brief
        </div>
        <nav className="flex flex-wrap justify-center gap-gutter">
          <a href="#" className="font-caption text-caption text-on-surface-variant hover:text-primary hover:underline transition-colors">
            Privacy
          </a>
          <a href="#" className="font-caption text-caption text-on-surface-variant hover:text-primary hover:underline transition-colors">
            Terms
          </a>
          <a href="#" className="font-caption text-caption text-on-surface-variant hover:text-primary hover:underline transition-colors">
            Editorial Guidelines
          </a>
          <a href="#" className="font-caption text-caption text-on-surface-variant hover:text-primary hover:underline transition-colors">
            Contact
          </a>
        </nav>
        <div className="font-caption text-caption text-on-surface-variant">
          &copy; 2024 The Brief. Editorial Excellence.
        </div>
      </div>
    </footer>
  )
}

export default Footer
