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
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/inbox" element={<Inbox />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/board" element={<CrmBoard />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR']} />}>
                <Route path="/users" element={<OrgUsers />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/departments" element={<OrgDepartments />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/orders" element={<Orders />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR']} />}>
                <Route path="/reports" element={<Reports />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR']} />}>
                <Route path="/campaigns" element={<Campaigns />} />
                <Route path="/llamadas" element={<CallCampaigns />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN']} />}>
                <Route path="/settings" element={<OrgSettings />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                {/* Named /desarrolladores (not /api): the backend already owns /api/* for its own
                    routes, so a frontend route at /api served the API's JSON banner instead of
                    this page on a direct visit or reload. */}
                <Route path="/desarrolladores" element={<ApiPortal />} />
              </Route>

              <Route element={<ProtectedRoute roles={['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT']} />}>
                <Route path="/ai-agents" element={<AiAgents />} />
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
