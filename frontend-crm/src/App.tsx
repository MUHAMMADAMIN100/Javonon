import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth';
import Login from './pages/Login';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Dashboard from './pages/Dashboard';
import Applications from './pages/Applications';
import ApplicationDetail from './pages/ApplicationDetail';
import Students from './pages/Students';
import StudentDetail from './pages/StudentDetail';
import StudentNew from './pages/StudentNew';
import Users from './pages/Users';
import Tasks from './pages/Tasks';
import Programs from './pages/Programs';
import Activity from './pages/Activity';
import TimeTracker from './pages/TimeTracker';
import Finance from './pages/Finance';
import Salary from './pages/Salary';
import Kpi from './pages/Kpi';
import Reports from './pages/Reports';
import Chat from './pages/Chat';
import Lms from './pages/Lms';

export default function App() {
  const init = useAuth((s) => s.init);
  const initialized = useAuth((s) => s.initialized);

  useEffect(() => { init(); }, [init]);

  if (!initialized) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        Загрузка...
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/applications" element={<Applications />} />
        <Route path="/applications/:id" element={<ApplicationDetail />} />
        <Route path="/students" element={<Students />} />
        <Route path="/students/new" element={<StudentNew />} />
        <Route path="/students/:id" element={<StudentDetail />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/programs" element={<Programs />} />
        <Route path="/users" element={<Users />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/time" element={<TimeTracker />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/finance" element={<Finance />} />
        <Route path="/salary" element={<Salary />} />
        <Route path="/kpi" element={<Kpi />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/lms" element={<Lms />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
