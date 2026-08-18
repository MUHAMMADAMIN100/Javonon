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
import ProgramDetail from './pages/ProgramDetail';
import Activity from './pages/Activity';
import TimeTracker from './pages/TimeTracker';
import Workday from './pages/Workday';
import Finance from './pages/Finance';
import Salary from './pages/Salary';
import Kpi from './pages/Kpi';
import Reports from './pages/Reports';
import Calls from './pages/Calls';
import Settings from './pages/Settings';
import Pipelines from './pages/Pipelines';
import MassMail from './pages/MassMail';
import Inbox from './pages/Inbox';
import Offers from './pages/Offers';
import Excuses from './pages/Excuses';
import Attendance from './pages/Attendance';
import Chat from './pages/Chat';
import Lms from './pages/LMS';
import Partners from './pages/Partners';
import PartnerDetail from './pages/PartnerDetail';
import UserDetail, { MyProfile } from './pages/UserDetail';
import Submissions from './pages/Submissions';
import SubmissionForm from './pages/SubmissionForm';
import SubmissionDetail from './pages/SubmissionDetail';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import Schedule from './pages/Schedule';
import Loading from './components/Loading';

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const ready = useAuth((s) => s.ready);

  // On mount: read the persisted JWT, GET /auth/me, hydrate the auth store.
  // While this is in-flight we render <Loading fullscreen /> so the user
  // never sees a login flash on reload with a valid token.
  useEffect(() => { bootstrap(); }, [bootstrap]);

  if (!ready) {
    return <Loading fullscreen />;
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
        <Route path="/programs/:id" element={<ProgramDetail />} />
        {/* Учебные группы и календарь занятий. Индивидуальный студент —
            это группа из одного человека, отдельного роута под него нет. */}
        <Route path="/groups" element={<Groups />} />
        <Route path="/groups/:id" element={<GroupDetail />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/users" element={<Users />} />
        <Route path="/users/:id" element={<UserDetail />} />
        {/* /profile/:id — для сотрудников с выданным доступом к чужому досье */}
        <Route path="/profile/:id" element={<UserDetail />} />
        <Route path="/me" element={<MyProfile />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/workday" element={<Workday />} />
        {/* Legacy: старые ссылки /time, /attendance, /excuses
            теперь открываются как табы внутри /workday. */}
        <Route path="/time" element={<Workday />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/pipelines" element={<Pipelines />} />
        <Route path="/massmail" element={<MassMail />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/offers" element={<Offers />} />
        <Route path="/excuses" element={<Workday />} />
        <Route path="/attendance" element={<Workday />} />
        <Route path="/finance" element={<Finance />} />
        <Route path="/salary" element={<Salary />} />
        <Route path="/submissions" element={<Submissions />} />
        <Route path="/submissions/new" element={<SubmissionForm />} />
        <Route path="/submissions/:id" element={<SubmissionDetail />} />
        <Route path="/kpi" element={<Kpi />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/lms" element={<Lms />} />
        <Route path="/partners" element={<Partners />} />
        <Route path="/partners/:id" element={<PartnerDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
