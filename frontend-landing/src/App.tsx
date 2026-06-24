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

export default function App() {
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
