import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme, Card } from '@mantine/core';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import './theme.css';
import dayjs from 'dayjs';
import 'dayjs/locale/en-gb';
import App from './App';

dayjs.locale('en-gb');

// v2 "dark sidebar" theme — emerald primary (Click2Leads brand), 8px radius, soft card shadows
const theme = createTheme({
  colors: {
    emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b'],
  },
  primaryColor: 'emerald',
  primaryShade: 5,
  defaultRadius: 'md',
  shadows: { xs: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)' },
  components: {
    Card: Card.extend({ defaultProps: { shadow: 'xs' } }),
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <App />
    </MantineProvider>
  </React.StrictMode>
);
