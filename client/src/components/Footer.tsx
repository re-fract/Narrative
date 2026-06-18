function Footer() {
  return (
    <footer className="bg-surface border-t border-outline-variant">
      <div className="w-full py-stack-lg px-margin-mobile md:px-margin-desktop flex flex-col md:flex-row justify-between items-center max-w-container-max mx-auto gap-stack-md">
        <div className="font-label text-label-caps tracking-widest text-primary uppercase">
          Narrative
        </div>
        <a
          href="https://github.com/re-fract/Narrative"
          target="_blank"
          rel="noopener noreferrer"
          className="font-caption text-caption text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[16px]">code</span>
          GitHub
        </a>
      </div>
    </footer>
  )
}

export default Footer
