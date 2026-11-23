import logo from '../../assets/compola-logo.svg';
import { BrandBackground } from './BrandBackground';

export const appName = 'Compola';

/** A splash while the client boots or signs in (Swift `SplashView`): the login page's logo row and a slim progress line. */
export function SplashView({ message }: { message: string }) {
  return (
    <BrandBackground>
      <div className="splash fade-in">
        <span className="login-logo-row">
          <img src={logo} width={48} height={48} alt="" draggable={false} />
          <span className="login-wordmark">{appName}</span>
        </span>
        <div className="splash-bar" aria-hidden>
          <div />
        </div>
        <div className="splash-status" role="status">
          {message}
        </div>
      </div>
    </BrandBackground>
  );
}
