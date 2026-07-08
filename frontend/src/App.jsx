import { BrowserRouter, Routes, Route, Navigate, NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { AppShell, NavLink, Group, Title, Button, Text } from '@mantine/core';
import { getUser, logout } from './api';
import Login from './pages/Login';
import Summary from './pages/Summary';
import Leads from './pages/Leads';
import Affiliates from './pages/Affiliates';

function Shell({ children }) {
  const user = getUser();
  const location = useLocation();
  const links = [
    { to: '/', label: 'Summary' },
    { to: '/leads', label: 'Leads' },
    ...(user.role === 'admin'
      ? [{ to: '/affiliates', label: 'Affiliates' }, { to: '/imports', label: 'Imports' }]
      : []),
    { to: '/export', label: 'Export' },
  ];
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 200, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group justify="space-between" h="100%" px="md">
          <Title order={4}>PCP Affiliate Dashboard</Title>
          <Group gap="sm">
            <Text size="sm" c="dimmed">{user.email}</Text>
            <Button size="xs" variant="default" onClick={logout}>Log out</Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {links.map((l) => (
          <NavLink key={l.to} component={RouterNavLink} to={l.to} label={l.label} active={location.pathname === l.to} />
        ))}
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
        <Route path="/affiliates" element={<RequireAuth><Affiliates /></RequireAuth>} />
        <Route path="/imports" element={<RequireAuth><div>Imports (Task 17)</div></RequireAuth>} />
        <Route path="/export" element={<RequireAuth><div>Export (Task 18)</div></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
