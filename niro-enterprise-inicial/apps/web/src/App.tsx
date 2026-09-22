import { lazy, Suspense } from 'react';
import { PwaExperience } from './components/PwaExperience';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AlertProvider } from './context/AlertContext';
import { OutcomeProvider } from './context/OutcomeContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';
import { ChangePassword } from './routes/ChangePassword';
import { Home } from './routes/Home';

// El resto de las páginas se cargan solo cuando se visitan (en vez de todas de una en el bundle
// principal): así el primer login no descarga, por ejemplo, el editor de flujos de bot si el
// usuario solo va a usar el Inbox. Login/ChangePassword/Home/Layout quedan eager porque son la
// primera pantalla que ve todo el mundo, con o sin sesión.
const SuperadminOrganizations = lazy(() => import('./routes/SuperadminOrganizations').then((m) => ({ default: m.SuperadminOrganizations })));
const OrgUsers = lazy(() => import('./routes/OrgUsers').then((m) => ({ default: m.OrgUsers })));
const OrgDepartments = lazy(() => import('./routes/OrgDepartments').then((m) => ({ default: m.OrgDepartments })));
const OrgSettings = lazy(() => import('./routes/OrgSettings').then((m) => ({ default: m.OrgSettings })));
const Inbox = lazy(() => import('./routes/Inbox').then((m) => ({ default: m.Inbox })));
const CrmBoard = lazy(() => import('./routes/CrmBoard').then((m) => ({ default: m.CrmBoard })));
const Campaigns = lazy(() => import('./routes/Campaigns').then((m) => ({ default: m.Campaigns })));
const Orders = lazy(() => import('./routes/Orders').then((m) => ({ default: m.Orders })));
const Reports = lazy(() => import('./routes/Reports').then((m) => ({ default: m.Reports })));
const History = lazy(() => import('./routes/History').then((m) => ({ default: m.History })));
const Management = lazy(() => import('./routes/Management').then((m) => ({ default: m.Management })));
const Sms = lazy(() => import('./routes/Sms').then((m) => ({ default: m.Sms })));
const SmsAdmin = lazy(() => import('./routes/SmsAdmin').then((m) => ({ default: m.SmsAdmin })));
const ApiPortal = lazy(() => import('./routes/ApiPortal').then((m) => ({ default: m.ApiPortal })));
const AiAgents = lazy(() => import('./routes/AiAgents').then((m) => ({ default: m.AiAgents })));
const BotFlow = lazy(() => import('./routes/BotFlow').then((m) => ({ default: m.BotFlow })));
const CallCampaigns = lazy(() => import('./routes/CallCampaigns').then((m) => ({ default: m.CallCampaigns })));
const StatusPosts = lazy(() => import('./routes/StatusPosts').then((m) => ({ default: m.StatusPosts })));
const Billing = lazy(() => import('./routes/Billing').then((m) => ({ default: m.Billing })));
const Contacts = lazy(() => import('./routes/Contacts').then((m) => ({ default: m.Contacts })));
const Groups = lazy(() => import('./routes/Groups').then((m) => ({ default: m.Groups })));
const SuperadminPlans = lazy(() => import('./routes/SuperadminPlans').then((m) => ({ default: m.SuperadminPlans })));
const SuperadminBilling = lazy(() => import('./routes/SuperadminBilling').then((m) => ({ default: m.SuperadminBilling })));

function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <span
        style={{
          width: 28, height: 28, borderRadius: '50%',
          border: '3px solid var(--border-color)', borderTopColor: 'var(--primary)',
          animation: 'app-route-spin 0.8s linear infinite'
        }}
      />
      <style>{'@keyframes app-route-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <BrowserRouter>
          <PwaExperience />
          <AuthProvider>
          <OutcomeProvider>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Login />} />
            <Route path="/landing" element={<Login />} />
            <Route path="/login" element={<Login />} />

          <Route element={<ProtectedRoute />}>
            <Route path="/change-password" element={<ChangePassword />} />

            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Home />} />
              <Route path="/home" element={<Home />} />

              <Route element={<ProtectedRoute roles={['SUPERADMIN']} />}>
                <Route path="/organizations" element={<SuperadminOrganizations />} />
                <Route path="/clientes" element={<SuperadminBilling />} />
                <Route path="/planes" element={<SuperadminPlans />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/inbox" element={<Inbox />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN']} />}>
                <Route path="/billing" element={<Billing />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="contacts" />}>
                <Route path="/contactos" element={<Contacts />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="groups" />}>
                <Route path="/grupos" element={<Groups />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="crm" />}>
                <Route path="/board" element={<CrmBoard />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR']} />}>
                <Route path="/users" element={<OrgUsers />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/departments" element={<OrgDepartments />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="orders" />}>
                <Route path="/orders" element={<Orders />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR']} permission="sms" />}>
                <Route path="/sms" element={<Sms />} />
              </Route>

              <Route element={<ProtectedRoute roles={['SUPERADMIN']} />}>
                <Route path="/sms-admin" element={<SmsAdmin />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="management" />}>
                <Route path="/gestion" element={<Management />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="reports" />}>
                <Route path="/reports" element={<Reports />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="history" />}>
                <Route path="/historial" element={<History />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="campaigns" />}>
                <Route path="/campaigns" element={<Campaigns />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="calls" />}>
                <Route path="/llamadas" element={<CallCampaigns />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="statuses" />}>
                <Route path="/estados" element={<StatusPosts />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN']} />}>
                <Route path="/settings" element={<OrgSettings />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="developers" />}>
                {/* Named /desarrolladores (not /api): the backend already owns /api/* for its own routes. */}
                <Route path="/desarrolladores" element={<ApiPortal />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="aiAgents" />}>
                <Route path="/ai-agents" element={<AiAgents />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="bot" />}>
                <Route path="/bot" element={<BotFlow />} />
              </Route>
            </Route>
          </Route>
        </Routes>
          </Suspense>
          </OutcomeProvider>
          </AuthProvider>
        </BrowserRouter>
      </AlertProvider>
    </ThemeProvider>
  );
}
