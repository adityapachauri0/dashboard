import { BrowserRouter, Routes, Route, Navigate, NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { AppShell, NavLink, Group, Button, Text, Box } from '@mantine/core';
import { IconLayoutDashboard, IconUsers, IconAffiliate, IconFileImport, IconFileExport, IconCode, IconReplace } from '@tabler/icons-react';
import { getUser, logout } from './api';
import Login from './pages/Login';
import Summary from './pages/Summary';
import Leads from './pages/Leads';
import Affiliates from './pages/Affiliates';
import Imports from './pages/Imports';
import ExportPage from './pages/ExportPage';
import ApiDocs from './pages/ApiDocs';
import Replacements from './pages/Replacements';

const ICONS = {
  '/': IconLayoutDashboard,
  '/leads': IconUsers,
  '/affiliates': IconAffiliate,
  '/imports': IconFileImport,
  '/export': IconFileExport,
  '/docs': IconCode,
  '/replacements': IconReplace,
};

function Shell({ children }) {
  const user = getUser();
  const location = useLocation();
  const links = [
    { to: '/', label: 'Summary' },
    { to: '/leads', label: 'Leads' },
    { to: '/replacements', label: 'Replacements' },
    ...(user.role === 'admin'
      ? [{ to: '/affiliates', label: 'Affiliates' }, { to: '/imports', label: 'Imports' }]
      : []),
    { to: '/export', label: 'Export' },
    { to: '/docs', label: 'API docs' },
  ];
  return (
    <AppShell navbar={{ width: 240, breakpoint: 'sm' }} padding="lg">
      <AppShell.Navbar p="sm" className="sidebar">
        <Text className="sidebar-brand">PCP Affiliate Dashboard</Text>
        <Box style={{ flex: 1 }}>
          {links.map((l) => {
            const Icon = ICONS[l.to];
            return (
              <NavLink key={l.to} component={RouterNavLink} to={l.to} label={l.label}
                leftSection={Icon ? <Icon size={18} stroke={1.75} /> : undefined}
                active={location.pathname === l.to} />
            );
          })}
        </Box>
        <Group className="sidebar-footer" justify="space-between" gap="sm" wrap="nowrap">
          <Text size="sm" truncate>{user.email}</Text>
          <Button size="xs" variant="default" className="sidebar-logout" style={{ flex: 'none' }} onClick={logout}>Log out</Button>
        </Group>
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

function RequireAuth({ children }) {
  return getUser() ? <Shell>{children}</Shell> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><Summary /></RequireAuth>} />
        <Route path="/leads" element={<RequireAuth><Leads /></RequireAuth>} />
        <Route path="/replacements" element={<RequireAuth><Replacements /></RequireAuth>} />
        <Route path="/affiliates" element={<RequireAuth><Affiliates /></RequireAuth>} />
        <Route path="/imports" element={<RequireAuth><Imports /></RequireAuth>} />
        <Route path="/export" element={<RequireAuth><ExportPage /></RequireAuth>} />
        <Route path="/docs" element={<RequireAuth><ApiDocs /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
