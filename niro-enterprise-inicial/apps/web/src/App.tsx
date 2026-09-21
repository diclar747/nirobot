import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AlertProvider } from './context/AlertContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';
import { ChangePassword } from './routes/ChangePassword';
import { Home } from './routes/Home';
import { SuperadminOrganizations } from './routes/SuperadminOrganizations';
import { OrgUsers } from './routes/OrgUsers';
import { OrgDepartments } from './routes/OrgDepartments';
import { OrgSettings } from './routes/OrgSettings';
import { Inbox } from './routes/Inbox';
import { CrmBoard } from './routes/CrmBoard';
import { Campaigns } from './routes/Campaigns';
import { Orders } from './routes/Orders';
import { Reports } from './routes/Reports';
import { ApiPortal } from './routes/ApiPortal';
import { AiAgents } from './routes/AiAgents';
import { BotFlow } from './routes/BotFlow';
import { CallCampaigns } from './routes/CallCampaigns';
import { StatusPosts } from './routes/StatusPosts';
import { Billing } from './routes/Billing';
import { Contacts } from './routes/Contacts';
import { SuperadminPlans } from './routes/SuperadminPlans';
import { SuperadminBilling } from './routes/SuperadminBilling';

export function App() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <BrowserRouter>
          <AuthProvider>
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

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} permission="reports" />}>
                <Route path="/reports" element={<Reports />} />
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
          </AuthProvider>
        </BrowserRouter>
      </AlertProvider>
    </ThemeProvider>
  );
}
