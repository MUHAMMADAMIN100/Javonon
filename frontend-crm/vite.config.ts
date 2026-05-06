import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CRM Javonon деплоится по пути /admin (и на собственном домене javonon-crm.vercel.app/admin,
// и проксируется через javonon.vercel.app/admin). Поэтому base = '/admin/'.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: { port: 5174 },
});
