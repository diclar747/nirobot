import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../styles/landing.css';

export function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [demoModalOpen, setDemoModalOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>('5 Agentes');

  // Form State
  const [demoForm, setDemoForm] = useState({ name: '', company: '', phone: '', email: '', agents: '5' });
  const [demoSubmitted, setDemoSubmitted] = useState(false);

  const handleOpenDemo = (planName?: string) => {
    if (planName) setSelectedPlan(planName);
    setDemoModalOpen(true);
  };

  const handleDemoSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setDemoSubmitted(true);
    setTimeout(() => {
      setDemoSubmitted(false);
      setDemoModalOpen(false);
      alert('¡Gracias! Un especialista de Niro se comunicará contigo por WhatsApp en breve.');
    }, 1200);
  };

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="landing-body">
      {/* Dynamic Background Glows */}
      <div className="landing-bg-glows">
        <div className="glow-top-center" />
        <div className="glow-hero-right" />
        <div className="glow-pricing" />
      </div>

      {/* Floating WhatsApp Quick Action */}
      <a
        href="https://wa.me/595981123456?text=Hola%20Niro,%20deseo%20m%C3%A1s%20informaci%C3%B3n%20sobre%20la%20plataforma"
        target="_blank"
        rel="noopener noreferrer"
        className="floating-whatsapp-widget"
        title="Hablar por WhatsApp con Niro"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.201.662.591 1.221.774 1.394.86.174.086.275.072.376-.043.101-.116.433-.506.549-.68.116-.173.231-.144.39-.086s1.011.477 1.184.564.289.13.332.202c.043.073.043.419-.101.824z" />
          <path d="M12 2C6.48 2 2 6.48 2 12c0 1.82.49 3.53 1.35 5L2 22l5.18-1.32C8.62 21.53 10.26 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18.2c-1.61 0-3.11-.47-4.38-1.28l-.31-.2-3.08.79.82-2.99-.21-.33C3.99 14.88 3.5 13.49 3.5 12 3.5 7.31 7.31 3.5 12 3.5 16.69 3.5 20.5 7.31 20.5 12c0 4.69-3.81 8.2-8.5 8.2z" />
        </svg>
        <span>Conectado con WhatsApp</span>
      </a>

      {/* NAVBAR */}
      <header className="landing-navbar">
        <div className="landing-container">
          <div className="landing-nav-inner">
            {/* Logo */}
            <Link to="/" className="landing-logo">
              <svg width="38" height="38" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="niro-nav-glow" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#38bdf8" />
                    <stop offset="0.5" stopColor="#0284c7" />
                    <stop offset="1" stopColor="#2563eb" />
                  </linearGradient>
                </defs>
                <rect width="40" height="40" rx="12" fill="url(#niro-nav-glow)" />
                <path
                  d="M11 27V14.5c0-.9 1.1-1.4 1.8-.8l14.4 13.6c.7.6 1.8.1 1.8-.8V13"
                  stroke="#ffffff"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="landing-logo-text">
                <span className="landing-logo-title">NIRO</span>
                <span className="landing-logo-subtitle">Siempre contigo ♡</span>
              </div>
            </Link>

            {/* Desktop Navigation Links */}
            <nav>
              <ul className="landing-nav-links">
                <li><a href="#inicio" onClick={(e) => { e.preventDefault(); scrollToSection('inicio'); }}>Inicio</a></li>
                <li><a href="#que-es-niro" onClick={(e) => { e.preventDefault(); scrollToSection('que-es-niro'); }}>¿Qué es Niro?</a></li>
                <li><a href="#funciones" onClick={(e) => { e.preventDefault(); scrollToSection('funciones'); }}>Funciones</a></li>
                <li><a href="#app-movil" onClick={(e) => { e.preventDefault(); scrollToSection('app-movil'); }}>App Móvil</a></li>
                <li><a href="#planes" onClick={(e) => { e.preventDefault(); scrollToSection('planes'); }}>Planes</a></li>
                <li><a href="#clientes" onClick={(e) => { e.preventDefault(); scrollToSection('clientes'); }}>Clientes</a></li>
                <li><a href="#contacto" onClick={(e) => { e.preventDefault(); setContactModalOpen(true); }}>Contacto</a></li>
              </ul>
            </nav>

            {/* Nav Actions */}
            <div className="landing-nav-actions">
              {user ? (
                <Link to="/inbox" className="btn-niro-primary">
                  Ir al panel →
                </Link>
              ) : (
                <>
                  <button onClick={() => handleOpenDemo()} className="btn-niro-ghost">
                    Iniciar demo
                  </button>
                  <Link to="/login" className="btn-niro-primary">
                    Empieza ahora →
                  </Link>
                </>
              )}

              <button
                className="landing-menu-toggle"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label="Menu"
              >
                {mobileMenuOpen ? '✕' : '☰'}
              </button>
            </div>
          </div>

          {/* Mobile Navigation Dropdown */}
          {mobileMenuOpen && (
            <div className="landing-mobile-menu">
              <a href="#inicio" onClick={(e) => { e.preventDefault(); scrollToSection('inicio'); }}>Inicio</a>
              <a href="#que-es-niro" onClick={(e) => { e.preventDefault(); scrollToSection('que-es-niro'); }}>¿Qué es Niro?</a>
              <a href="#funciones" onClick={(e) => { e.preventDefault(); scrollToSection('funciones'); }}>Funciones</a>
              <a href="#app-movil" onClick={(e) => { e.preventDefault(); scrollToSection('app-movil'); }}>App Móvil</a>
              <a href="#planes" onClick={(e) => { e.preventDefault(); scrollToSection('planes'); }}>Planes</a>
              <a href="#clientes" onClick={(e) => { e.preventDefault(); scrollToSection('clientes'); }}>Clientes</a>
              <a href="#contacto" onClick={(e) => { e.preventDefault(); setContactModalOpen(true); }}>Contacto</a>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <button onClick={() => handleOpenDemo()} className="btn-niro-ghost" style={{ flex: 1 }}>
                  Iniciar demo
                </button>
                <Link to="/login" className="btn-niro-primary" style={{ flex: 1, textAlign: 'center' }}>
                  Ingresar →
                </Link>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* HERO SECTION */}
      <section id="inicio" className="hero-section">
        <div className="landing-container">
          <div className="hero-grid">
            {/* Left Hero Content */}
            <div className="hero-content">
              <div className="landing-tag">
                <span style={{ fontSize: 13 }}>⚡</span> IA + WhatsApp + Multiagente
              </div>

              <h1 className="landing-title">
                Niro, el asistente inteligente para{' '}
                <span className="gradient-text">hacer crecer tu empresa</span>
              </h1>

              <p className="landing-subtitle">
                Atiende, automatiza, gestiona y fideliza a tus clientes desde un solo lugar. Conéctate con WhatsApp, crea múltiples agentes, transfiere chats y lleva el control completo de tus conversaciones.
              </p>

              <div className="hero-ctas">
                <button onClick={() => handleOpenDemo()} className="btn-niro-primary" style={{ padding: '15px 32px', fontSize: 16 }}>
                  Solicita una demo gratuita →
                </button>
                <button onClick={() => setVideoModalOpen(true)} className="btn-niro-ghost" style={{ padding: '15px 26px', fontSize: 16 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Ver video
                </button>
              </div>

              <div className="hero-trust-row">
                <div className="hero-trust-item">
                  <span className="check-icon">✓</span> Sin tarjeta de crédito
                </div>
                <div className="hero-trust-item">
                  <span className="check-icon">✓</span> Implementación rápida
                </div>
                <div className="hero-trust-item">
                  <span className="check-icon">✓</span> Soporte en español
                </div>
              </div>
            </div>

            {/* Right Hero Graphic with Robot and Mockup Elements */}
            <div className="hero-visual-wrapper">
              <div className="hero-robot-container">
                {/* Speech Bubble */}
                <div className="hero-speech-bubble">
                  <div className="greeting">¡Hola! Soy Niro</div>
                  <div className="handwriting">Tu aliado inteligente ♡</div>
                </div>

                {/* Main Hero Visual Image */}
                <img
                  src="/images/landin.png"
                  alt="Niro Plataforma Inteligente Multiagente con WhatsApp"
                  className="hero-robot-img"
                  style={{
                    objectFit: 'cover',
                    objectPosition: 'top 0% left 38%',
                    height: '420px',
                    width: '100%'
                  }}
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    if (target.src.includes('landin.png')) {
                      target.src = '/images/1.png';
                    }
                  }}
                />

                {/* Floating Live Feature Badges */}
                <div className="hero-floating-badges">
                  <div className="floating-pill">
                    <span style={{ color: '#25d366' }}>●</span> Conecta WhatsApp
                  </div>
                  <div className="floating-pill">
                    <span>👥</span> Atiende a tus clientes
                  </div>
                  <div className="floating-pill">
                    <span>🔄</span> Transfiere a un agente
                  </div>
                  <div className="floating-pill">
                    <span>📈</span> Gestiona y haz crecer tu negocio
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* METRICS / STATS BAR */}
      <section className="stats-section">
        <div className="landing-container">
          <div className="stats-card-container">
            {/* Stat 1 */}
            <div className="stat-item">
              <div className="stat-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="stat-info">
                <span className="stat-number">+500</span>
                <span className="stat-label">Empresas confían en Niro</span>
              </div>
            </div>

            {/* Stat 2 */}
            <div className="stat-item">
              <div className="stat-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div className="stat-info">
                <span className="stat-number">+1 millón</span>
                <span className="stat-label">Conversaciones gestionadas</span>
              </div>
            </div>

            {/* Stat 3 */}
            <div className="stat-item">
              <div className="stat-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </div>
              <div className="stat-info">
                <span className="stat-number">98%</span>
                <span className="stat-label">Clientes más satisfechos</span>
              </div>
            </div>

            {/* Stat 4 */}
            <div className="stat-item">
              <div className="stat-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <div className="stat-info">
                <span className="stat-number">70%</span>
                <span className="stat-label">Consultas resueltas por IA</span>
              </div>
            </div>

            {/* Stat 5 */}
            <div className="stat-item">
              <div className="stat-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div className="stat-info">
                <span className="stat-number">24/7</span>
                <span className="stat-label">Siempre disponible</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES / TODO EN UN SOLO SISTEMA */}
      <section id="funciones" className="features-section">
        <div className="landing-container">
          <div className="section-header">
            <div className="landing-tag">TODO EN UN SOLO SISTEMA</div>
            <h2 className="landing-title">Una solución completa para tu negocio</h2>
            <p className="landing-subtitle">
              Niro combina inteligencia artificial, comunicación omnicanal y gestión empresarial en una plataforma fácil de usar, potente y segura.
            </p>
            <button onClick={() => scrollToSection('planes')} className="btn-niro-primary">
              Conoce todas las funcionalidades →
            </button>
          </div>

          <div className="features-grid">
            {/* Feature 1 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-whatsapp">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771z" />
                </svg>
              </div>
              <h3>WhatsApp integrado</h3>
              <p>Conecta tu número o múltiples números de WhatsApp corporativo de manera instantánea y segura.</p>
            </div>

            {/* Feature 2 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-purple">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3>Multiagente</h3>
              <p>Crea, asigna y gestiona múltiples agentes en departamentos de ventas, soporte y atención.</p>
            </div>

            {/* Feature 3 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-blue">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              </div>
              <h3>Transferencia de chats</h3>
              <p>Deriva conversaciones al agente o departamento adecuado con notas internas y contexto completo.</p>
            </div>

            {/* Feature 4 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-sky">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </div>
              <h3>CRM completo</h3>
              <p>Historial unificado, etiquetas personalizadas, notas de seguimiento y fichas de clientes.</p>
            </div>

            {/* Feature 5 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-magenta">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-5.04z" />
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-5.04z" />
                </svg>
              </div>
              <h3>Inteligencia artificial</h3>
              <p>Responde consultas frecuentes, automatiza cotizaciones y aprende de tu catálogo de productos.</p>
            </div>

            {/* Feature 6 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-emerald">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="9" cy="21" r="1" />
                  <circle cx="20" cy="21" r="1" />
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                </svg>
              </div>
              <h3>Gestión de pedidos</h3>
              <p>Ideal para ventas y logística: registra pedidos, estados de entrega y comprobantes desde el chat.</p>
            </div>

            {/* Feature 7 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-indigo">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
                  <path d="M22 12A10 10 0 0 0 12 2v10z" />
                </svg>
              </div>
              <h3>Reportes y estadísticas</h3>
              <p>Mide el rendimiento de tu equipo, tiempos de respuesta y volumen de consultas en tiempo real.</p>
            </div>

            {/* Feature 8 */}
            <div className="feature-card">
              <div className="feature-icon-box feature-icon-cyan">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              </div>
              <h3>Para todo tipo de empresa</h3>
              <p>Ferreterías, cooperativas, clínicas, bancos, constructoras y distribuidoras.</p>
            </div>
          </div>
        </div>
      </section>

      {/* MOBILE APP SHOWCASE SECTION (from 3.png & 1.png) */}
      <section id="app-movil" className="mobile-showcase-section">
        <div className="landing-container">
          <div className="mobile-showcase-card">
            <div className="mobile-showcase-grid">
              <div>
                <div className="landing-tag">APP MÓVIL & MULTIPLATAFORMA</div>
                <h2 className="landing-title" style={{ fontSize: 'clamp(1.8rem, 3vw, 2.5rem)' }}>
                  Tu negocio, <span className="gradient-text">en la palma de tu mano</span>
                </h2>
                <p className="landing-subtitle" style={{ maxWidth: '100%' }}>
                  Atiende clientes desde cualquier lugar con nuestra app para agentes. Recibe notificaciones push al instante, crea pedidos, transfiere conversaciones y revisa el historial del cliente en segundos.
                </p>

                <div className="mobile-features-pills">
                  <div className="mobile-feature-pill-item">
                    <span>📱</span> App rápida y ligera
                  </div>
                  <div className="mobile-feature-pill-item">
                    <span>🔔</span> Notificaciones en tiempo real
                  </div>
                  <div className="mobile-feature-pill-item">
                    <span>⚡</span> Modo offline y PWA
                  </div>
                  <div className="mobile-feature-pill-item">
                    <span>🔒</span> Seguridad de extremo a extremo
                  </div>
                </div>

                <div className="mobile-app-badges-row">
                  <a href="#demo" onClick={(e) => { e.preventDefault(); handleOpenDemo(); }} className="app-store-badge">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.84c.62-.75 1.04-1.8 0.93-2.84-.9.04-1.99.6-2.63 1.35-.57.65-1.07 1.72-.94 2.74 1 .08 2.02-.5 2.64-1.25z" />
                    </svg>
                    <div>
                      <div style={{ fontSize: 9, opacity: 0.8 }}>Disponible en</div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>App Store</div>
                    </div>
                  </a>

                  <a href="#demo" onClick={(e) => { e.preventDefault(); handleOpenDemo(); }} className="app-store-badge">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3.609 1.814L13.792 12 3.61 22.186c-.183-.22-.29-.5-.29-.816V2.63c0-.316.107-.596.29-.816zM15.207 13.414l2.138 2.138-11.5 6.64 9.362-8.778zM17.345 8.448L15.207 10.586 5.845 1.78l11.5 6.668zM18.759 12l2.368-1.368c.55-.318.55-.838 0-1.156L18.759 12z" />
                    </svg>
                    <div>
                      <div style={{ fontSize: 9, opacity: 0.8 }}>DISPONIBLE EN</div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>Google Play</div>
                    </div>
                  </a>

                  <div className="pwa-badge">
                    <span>⚡</span> Instalable como PWA
                  </div>
                </div>
              </div>

              {/* Mobile Screenshots Banner from 3.png */}
              <div className="mobile-screens-banner">
                <img
                  src="/images/3.png"
                  alt="Niro App Móvil para Agentes y Clientes"
                  className="mobile-screens-img"
                  style={{
                    maxHeight: '420px',
                    objectFit: 'cover',
                    objectPosition: 'top 12% center'
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* THEMES SHOWCASE SECTION (from 2.png) */}
      <section className="themes-section">
        <div className="landing-container">
          <div className="section-header">
            <div className="landing-tag">DISEÑO Y PERSONALIZACIÓN</div>
            <h2 className="landing-title">Una interfaz adaptada a tu estilo</h2>
            <p className="landing-subtitle">
              Elige entre tres temas modernos diseñados para máxima productividad y comodidad visual de tu equipo.
            </p>
          </div>

          <div className="themes-grid">
            {/* Theme 1: Azul */}
            <div className="theme-card">
              <div className="theme-preview-box">
                <img
                  src="/images/2.png"
                  alt="Tema Azul Moderno y Profesional"
                  style={{ objectPosition: 'top 5% left 0%', width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
              <div>
                <h3>Modelo 1: Azul Profesional</h3>
                <p>Equilibrado, confiable y enfocado en la claridad para equipos de soporte y ventas.</p>
              </div>
              <div className="theme-quote">"Juntos, llegamos más lejos ♡"</div>
            </div>

            {/* Theme 2: Claro */}
            <div className="theme-card">
              <div className="theme-preview-box">
                <img
                  src="/images/2.png"
                  alt="Tema Claro Minimalista y Limpio"
                  style={{ objectPosition: 'top 50% left 0%', width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
              <div>
                <h3>Modelo 2: Claro Minimalista</h3>
                <p>Espacioso, limpio y perfecto para ambientes luminosos y lectura continua.</p>
              </div>
              <div className="theme-quote">"Ideas de hoy, resultados de mañana ♡"</div>
            </div>

            {/* Theme 3: Oscuro */}
            <div className="theme-card">
              <div className="theme-preview-box">
                <img
                  src="/images/2.png"
                  alt="Tema Oscuro Futurista y Elegante"
                  style={{ objectPosition: 'top 95% left 0%', width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
              <div>
                <h3>Modelo 3: Oscuro Futurista</h3>
                <p>Elegancia nocturna, alto contraste y mínimo cansancio visual para largas jornadas.</p>
              </div>
              <div className="theme-quote">"Sin límites para lo que puedes lograr 🚀"</div>
            </div>
          </div>
        </div>
      </section>

      {/* PRICING SECTION */}
      <section id="planes" className="pricing-section">
        <div className="landing-container">
          <div className="section-header">
            <div className="landing-tag">PLANES FLEXIBLES</div>
            <h2 className="landing-title">Elige el plan ideal para tu empresa</h2>
            <p className="landing-subtitle">
              Todos nuestros planes incluyen IA, WhatsApp, CRM, reportes y soporte técnico.
            </p>
          </div>

          <div className="pricing-layout">
            {/* Left All-Included Summary Card */}
            <div className="pricing-info-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(56,189,248,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#38bdf8' }}>
                  ✓
                </div>
                <h4>Todos los planes incluyen:</h4>
              </div>
              <ul className="pricing-includes-list">
                <li>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>WhatsApp integrado</span>
                </li>
                <li>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>IA de Niro inteligente</span>
                </li>
                <li>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>CRM y gestión de pedidos</span>
                </li>
                <li>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Reportes en tiempo real</span>
                </li>
                <li>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Soporte técnico especializado</span>
                </li>
              </ul>
            </div>

            {/* 4 Pricing Cards */}
            <div className="pricing-cards-grid">
              {/* Plan 1: 2 Agentes */}
              <div className="pricing-tier-card">
                <div className="tier-header">
                  <div className="tier-icon-circle">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  </div>
                  <div className="tier-agents-name">2 Agentes</div>
                  <div className="tier-price-box">
                    <div className="tier-price">Gs. 49.000</div>
                    <div className="tier-period">por mes</div>
                  </div>
                </div>
                <ul className="tier-features-list">
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Hasta 2 agentes
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    WhatsApp integrado
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    CRM completo
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Reportes básicos
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Soporte por email
                  </li>
                </ul>
                <button onClick={() => handleOpenDemo('2 Agentes (Gs. 49.000)')} className="btn-tier-cta btn-tier-outline">
                  Comenzar
                </button>
              </div>

              {/* Plan 2: 5 Agentes (FEATURED) */}
              <div className="pricing-tier-card featured">
                <div className="tier-badge">MÁS ELEGIDO</div>
                <div className="tier-header">
                  <div className="tier-icon-circle" style={{ background: 'rgba(56,189,248,0.25)' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </div>
                  <div className="tier-agents-name">5 Agentes</div>
                  <div className="tier-price-box">
                    <div className="tier-price">Gs. 120.000</div>
                    <div className="tier-period">por mes</div>
                  </div>
                </div>
                <ul className="tier-features-list">
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Hasta 5 agentes
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    WhatsApp integrado
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    CRM completo
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Reportes avanzados
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Soporte prioritario
                  </li>
                </ul>
                <button onClick={() => handleOpenDemo('5 Agentes (Gs. 120.000)')} className="btn-tier-cta btn-tier-solid">
                  Comenzar
                </button>
              </div>

              {/* Plan 3: 10 Agentes */}
              <div className="pricing-tier-card">
                <div className="tier-header">
                  <div className="tier-icon-circle">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </div>
                  <div className="tier-agents-name">10 Agentes</div>
                  <div className="tier-price-box">
                    <div className="tier-price">Gs. 210.000</div>
                    <div className="tier-period">por mes</div>
                  </div>
                </div>
                <ul className="tier-features-list">
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Hasta 10 agentes
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    WhatsApp integrado
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    CRM completo
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Reportes avanzados
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Soporte prioritario
                  </li>
                </ul>
                <button onClick={() => handleOpenDemo('10 Agentes (Gs. 210.000)')} className="btn-tier-cta btn-tier-outline">
                  Comenzar
                </button>
              </div>

              {/* Plan 4: 25 Agentes */}
              <div className="pricing-tier-card">
                <div className="tier-header">
                  <div className="tier-icon-circle">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </div>
                  <div className="tier-agents-name">25 Agentes</div>
                  <div className="tier-price-box">
                    <div className="tier-price">Gs. 450.000</div>
                    <div className="tier-period">por mes</div>
                  </div>
                </div>
                <ul className="tier-features-list">
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Hasta 25 agentes
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    WhatsApp integrado
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    CRM completo
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Reportes avanzados
                  </li>
                  <li className="active">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    Soporte personalizado
                  </li>
                </ul>
                <button onClick={() => handleOpenDemo('25 Agentes (Gs. 450.000)')} className="btn-tier-cta btn-tier-outline">
                  Comenzar
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* INDUSTRIES SECTION ("PARA TODOS LOS RUBROS") */}
      <section id="que-es-niro" className="industries-section">
        <div className="landing-container">
          <div className="section-header">
            <div className="landing-tag">PARA TODOS LOS RUBROS</div>
            <h2 className="landing-title">Niro se adapta a tu industria</h2>
            <p className="landing-subtitle">
              Una solución flexible para empresas de cualquier tamaño y sector.
            </p>
          </div>

          <div className="industries-grid">
            <div className="industry-card">
              <div className="industry-icon">🧱</div>
              <span>Ferreterías y construcción</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">🏛️</div>
              <span>Cooperativas y financieras</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">💙</div>
              <span>Clínicas y salud</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">💳</div>
              <span>Bancos</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">🏭</div>
              <span>Industrias y distribuidoras</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">🎓</div>
              <span>Educación</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">🏛️</div>
              <span>Gobiernos e instituciones</span>
            </div>
            <div className="industry-card">
              <div className="industry-icon">💬</div>
              <span>Y muchos más...</span>
            </div>
          </div>
        </div>
      </section>

      {/* TESTIMONIALS SECTION ("LO QUE DICEN NUESTROS CLIENTES") */}
      <section id="clientes" className="testimonials-section">
        <div className="landing-container">
          <div className="section-header">
            <div className="landing-tag">LO QUE DICEN NUESTROS CLIENTES</div>
            <h2 className="landing-title">Empresas que ya confían a Niro</h2>
            <p className="landing-subtitle">
              Historias reales, resultados medibles.
            </p>
          </div>

          <div className="testimonials-grid">
            {/* Testimonial 1 */}
            <div className="testimonial-card">
              <p className="testimonial-quote">
                “Niro nos permitió atender el triple de clientes con el mismo equipo. Es una herramienta imprescindible.”
              </p>
              <div className="testimonial-author">
                <img
                  src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80"
                  alt="Carlos Ramírez"
                  className="author-avatar"
                />
                <div className="author-info">
                  <span className="author-name">Carlos Ramírez</span>
                  <span className="author-company">Ferretería El Sol</span>
                  <div className="author-stars">★★★★★</div>
                </div>
              </div>
            </div>

            {/* Testimonial 2 */}
            <div className="testimonial-card">
              <p className="testimonial-quote">
                “La integración con WhatsApp y el seguimiento de conversaciones nos dio un control total.”
              </p>
              <div className="testimonial-author">
                <img
                  src="https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=100&auto=format&fit=crop&q=80"
                  alt="María González"
                  className="author-avatar"
                />
                <div className="author-info">
                  <span className="author-name">María González</span>
                  <span className="author-company">Cooperativa San Miguel</span>
                  <div className="author-stars">★★★★★</div>
                </div>
              </div>
            </div>

            {/* Testimonial 3 */}
            <div className="testimonial-card">
              <p className="testimonial-quote">
                “La IA de Niro responde el 70% de las consultas. Nuestro equipo puede enfocarse en lo importante.”
              </p>
              <div className="testimonial-author">
                <img
                  src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&auto=format&fit=crop&q=80"
                  alt="Luis Herrera"
                  className="author-avatar"
                />
                <div className="author-info">
                  <span className="author-name">Luis Herrera</span>
                  <span className="author-company">Constructora del Sur</span>
                  <div className="author-stars">★★★★★</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FINAL CALL TO ACTION BANNER */}
      <section className="cta-banner-section">
        <div className="landing-container">
          <div className="cta-banner-card">
            <div className="cta-banner-content">
              <h2>¿Listo para transformar tu atención al cliente?</h2>
              <p>Únete a cientos de empresas que ya están creciendo con Niro.</p>
            </div>

            <div className="cta-banner-actions">
              <button onClick={() => handleOpenDemo()} className="btn-niro-primary">
                Solicita una demo gratuita →
              </button>
              <button onClick={() => setContactModalOpen(true)} className="btn-niro-ghost">
                Contáctanos
              </button>
            </div>

            <div className="cta-banner-slogan">
              "Tu empresa, más cerca de las personas ♡"
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="landing-footer">
        <div className="landing-container">
          <div className="footer-top">
            <div className="landing-logo">
              <svg width="34" height="34" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="40" height="40" rx="12" fill="url(#niro-nav-glow)" />
                <path
                  d="M11 27V14.5c0-.9 1.1-1.4 1.8-.8l14.4 13.6c.7.6 1.8.1 1.8-.8V13"
                  stroke="#ffffff"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="landing-logo-text">
                <span className="landing-logo-title" style={{ fontSize: 20 }}>NIRO</span>
                <span className="landing-logo-subtitle">Siempre contigo</span>
              </div>
            </div>

            <ul className="footer-nav-links">
              <li><a href="#inicio" onClick={(e) => { e.preventDefault(); scrollToSection('inicio'); }}>Inicio</a></li>
              <li><a href="#funciones" onClick={(e) => { e.preventDefault(); scrollToSection('funciones'); }}>Funciones</a></li>
              <li><a href="#app-movil" onClick={(e) => { e.preventDefault(); scrollToSection('app-movil'); }}>App Móvil</a></li>
              <li><a href="#planes" onClick={(e) => { e.preventDefault(); scrollToSection('planes'); }}>Planes</a></li>
              <li><a href="#clientes" onClick={(e) => { e.preventDefault(); scrollToSection('clientes'); }}>Clientes</a></li>
              <li><a href="#blog" onClick={(e) => { e.preventDefault(); alert('Blog próximamente'); }}>Blog</a></li>
              <li><a href="#contacto" onClick={(e) => { e.preventDefault(); setContactModalOpen(true); }}>Contacto</a></li>
            </ul>

            <div className="footer-social-links">
              {/* WhatsApp */}
              <a href="https://wa.me/595981123456" target="_blank" rel="noreferrer" className="social-icon-btn" title="WhatsApp">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771z" />
                </svg>
              </a>
              {/* Facebook */}
              <a href="https://facebook.com" target="_blank" rel="noreferrer" className="social-icon-btn" title="Facebook">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
                </svg>
              </a>
              {/* Instagram */}
              <a href="https://instagram.com" target="_blank" rel="noreferrer" className="social-icon-btn" title="Instagram">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                </svg>
              </a>
              {/* LinkedIn */}
              <a href="https://linkedin.com" target="_blank" rel="noreferrer" className="social-icon-btn" title="LinkedIn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
                  <rect x="2" y="9" width="4" height="12" />
                  <circle cx="4" cy="4" r="2" />
                </svg>
              </a>
            </div>
          </div>

          <div className="footer-bottom">
            <div>© 2025 Niro. Todos los derechos reservados.</div>
            <div className="footer-legal-links">
              <a href="#terminos" onClick={(e) => { e.preventDefault(); alert('Términos y condiciones'); }}>Términos</a>
              <a href="#privacidad" onClick={(e) => { e.preventDefault(); alert('Política de privacidad'); }}>Privacidad</a>
              <a href="#soporte" onClick={(e) => { e.preventDefault(); setContactModalOpen(true); }}>Soporte</a>
            </div>
          </div>
        </div>
      </footer>

      {/* DEMO REQUEST MODAL */}
      {demoModalOpen && (
        <div className="landing-modal-backdrop" onClick={() => setDemoModalOpen(false)}>
          <div className="landing-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setDemoModalOpen(false)}>✕</button>
            <div className="landing-tag">DEMO PERSONALIZADA</div>
            <h3 style={{ fontSize: 22, color: '#fff', margin: '0 0 8px 0' }}>Comienza con Niro</h3>
            <p style={{ fontSize: 13.5, color: '#94a3b8', margin: '0 0 20px 0' }}>
              Plan seleccionado: <strong style={{ color: '#38bdf8' }}>{selectedPlan}</strong>. Completa tus datos para activar tu demo en WhatsApp.
            </p>

            <form onSubmit={handleDemoSubmit}>
              <div className="landing-form-group">
                <label>Nombre y Apellido</label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Juan Pérez"
                  className="landing-form-input"
                  value={demoForm.name}
                  onChange={(e) => setDemoForm({ ...demoForm, name: e.target.value })}
                />
              </div>

              <div className="landing-form-group">
                <label>Nombre de la Empresa</label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Ferretería Central"
                  className="landing-form-input"
                  value={demoForm.company}
                  onChange={(e) => setDemoForm({ ...demoForm, company: e.target.value })}
                />
              </div>

              <div className="landing-form-group">
                <label>Número de WhatsApp (con código de país)</label>
                <input
                  type="tel"
                  required
                  placeholder="+595 981 123456"
                  className="landing-form-input"
                  value={demoForm.phone}
                  onChange={(e) => setDemoForm({ ...demoForm, phone: e.target.value })}
                />
              </div>

              <div className="landing-form-group">
                <label>Correo Electrónico de la Empresa</label>
                <input
                  type="email"
                  required
                  placeholder="admin@empresa.com"
                  className="landing-form-input"
                  value={demoForm.email}
                  onChange={(e) => setDemoForm({ ...demoForm, email: e.target.value })}
                />
              </div>

              <button
                type="submit"
                className="btn-niro-primary"
                style={{ width: '100%', marginTop: 14, padding: '13px' }}
                disabled={demoSubmitted}
              >
                {demoSubmitted ? 'Activando...' : 'Solicitar demo gratuita ahora →'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* VIDEO PREVIEW MODAL */}
      {videoModalOpen && (
        <div className="landing-modal-backdrop" onClick={() => setVideoModalOpen(false)}>
          <div className="landing-modal-card" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setVideoModalOpen(false)}>✕</button>
            <div className="landing-tag">DEMO EN VIVO</div>
            <h3 style={{ fontSize: 22, color: '#fff', margin: '0 0 16px 0' }}>Conoce a Niro en acción</h3>
            <div style={{ position: 'relative', width: '100%', paddingBottom: '56.25%', borderRadius: 14, overflow: 'hidden', background: '#000' }}>
              <img
                src="/images/2.png"
                alt="Niro Plataforma Demo"
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff', textAlign: 'center', padding: 20 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#0284c7', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12, boxShadow: '0 0 25px rgba(2,132,199,0.8)' }}>
                  ▶
                </div>
                <h4 style={{ margin: '0 0 6px 0', fontSize: 18 }}>Plataforma Omnicanal Multiagente</h4>
                <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1' }}>Atención rápida, bot de catálogo y panel de agentes en tiempo real.</p>
              </div>
            </div>
            <div style={{ marginTop: 20, textAlign: 'center' }}>
              <button onClick={() => { setVideoModalOpen(false); handleOpenDemo(); }} className="btn-niro-primary">
                Probar en mi empresa →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONTACT MODAL */}
      {contactModalOpen && (
        <div className="landing-modal-backdrop" onClick={() => setContactModalOpen(false)}>
          <div className="landing-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setContactModalOpen(false)}>✕</button>
            <div className="landing-tag">CONTACTO DIRECTO</div>
            <h3 style={{ fontSize: 22, color: '#fff', margin: '0 0 8px 0' }}>Habla con un asesor de Niro</h3>
            <p style={{ fontSize: 13.5, color: '#94a3b8', margin: '0 0 20px 0' }}>
              Estamos disponibles para responder todas tus preguntas técnicas y comerciales.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <a
                href="https://wa.me/595981123456"
                target="_blank"
                rel="noreferrer"
                className="btn-niro-whatsapp"
                style={{ padding: '14px 20px', fontSize: 15, justifyContent: 'center' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771z" />
                </svg>
                Chatear con soporte por WhatsApp
              </a>

              <button
                onClick={() => { setContactModalOpen(false); navigate('/login'); }}
                className="btn-niro-ghost"
                style={{ padding: '14px 20px', fontSize: 15, justifyContent: 'center' }}
              >
                Ingresar a la plataforma de agentes →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
