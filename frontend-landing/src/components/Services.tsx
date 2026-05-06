import { motion } from 'framer-motion';
import Icon from '../Icon';

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Services() {
  return (
    <section id="services">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="eyebrow">What we do</span>
            <h2 className="display">
              One partner from <em>maybe</em><br />to admission letter.
            </h2>
          </div>
          <p>
            We don't just file paperwork. We engineer your candidacy — choosing the
            right grants, sharpening your story, and getting you across the line.
          </p>
        </div>

        <div className="bento">
          <motion.div
            className="bento-card feature span-4 row-2"
            variants={fadeUp}
            custom={0}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div>
              <div className="bento-icon">
                <Icon name="travel_explore" size={24} />
              </div>
              <h3>Grant matching with surgical precision.</h3>
            </div>
            <p>
              We map your profile against 60+ active scholarships and shortlist the
              ones where you're not just eligible — you're competitive. No spam
              applications. Only signal.
            </p>
            <span className="bento-num">01</span>
          </motion.div>

          <motion.div
            className="bento-card span-2"
            variants={fadeUp}
            custom={1}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="edit_document" size={22} />
            </div>
            <h3>Application craft</h3>
            <p>Personal statements, motivation letters, study plans — written with you, not for you.</p>
            <span className="bento-num">02</span>
          </motion.div>

          <motion.div
            className="bento-card accent span-2"
            variants={fadeUp}
            custom={2}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="forum" size={22} />
            </div>
            <h3>Interview labs</h3>
            <p>Mock interviews with alumni who passed your exact committee.</p>
            <span className="bento-num">03</span>
          </motion.div>

          <motion.div
            className="bento-card span-2"
            variants={fadeUp}
            custom={3}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="language" size={22} />
            </div>
            <h3>Test prep</h3>
            <p>IELTS, TOEFL, GRE, GMAT, HSK, TOPIK — targeted prep for your university.</p>
            <span className="bento-num">04</span>
          </motion.div>

          <motion.div
            className="bento-card span-2"
            variants={fadeUp}
            custom={4}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="flight_takeoff" size={22} />
            </div>
            <h3>Visa & relocation</h3>
            <p>Embassy paperwork, housing, airport pickup, first-week onboarding.</p>
            <span className="bento-num">05</span>
          </motion.div>

          <motion.div
            className="bento-card span-3"
            variants={fadeUp}
            custom={5}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="favorite" size={22} />
            </div>
            <h3>Lifelong network</h3>
            <p>You're never an alumnus of Javonon — you're family. Mentorship, referrals, opportunities long after the diploma.</p>
            <span className="bento-num">06</span>
          </motion.div>

          <motion.div
            className="bento-card span-3"
            variants={fadeUp}
            custom={6}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="bolt" size={22} />
            </div>
            <h3>30-min response time</h3>
            <p>Your dedicated manager replies within half an hour during business hours. No tickets, no queues.</p>
            <span className="bento-num">07</span>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
