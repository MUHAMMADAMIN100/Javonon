import Header from './components/Header';
import Hero from './components/Hero';
import Services from './components/Services';
import Directions from './components/Directions';
import PublicProgramsSection from './components/PublicProgramsSection';
import Advantages from './components/Advantages';
import Testimonials from './components/Testimonials';
import ApplicationForm from './components/ApplicationForm';
import Contacts from './components/Contacts';
import Footer from './components/Footer';
import { useEffect } from 'react';
import { captureReferralFromUrl, scrollToApplyForm } from './referral';

export default function App() {
  useEffect(() => {
    // captureReferralFromUrl идемпотентна — main.tsx уже звал её до рендера,
    // здесь мы лишь забираем мемоизированный результат, чтобы не парсить URL
    // второй раз и не слать второй click-пинг.
    const ref = captureReferralFromUrl();

    if (ref) {
      // Пришли по партнёрской ссылке `/?ref=CODE#apply` — везём сразу к форме
      // и подсвечиваем её: иначе человек падает на первый экран длинного
      // лендинга и не понимает, что от него хотят.
      scrollToApplyForm({ highlight: true });
      return;
    }

    // Голый якорь без ?ref= (кто-то поделился '/#apply' напрямую). Нативно
    // браузер отрабатывает фрагмент только если элемент существует на момент
    // парсинга — в SPA секции ещё нет, поэтому доскролливаем сами.
    if (window.location.hash === '#apply') {
      scrollToApplyForm();
    }
  }, []);

  return (
    <>
      <Header />
      <main>
        <Hero />
        <Services />
        <Directions />
        {/* ТЗ-доработка п.8: каталог программ на главной — published=true. */}
        <PublicProgramsSection />
        <Advantages />
        <Testimonials />
        <ApplicationForm />
        <Contacts />
      </main>
      <Footer />
    </>
  );
}
