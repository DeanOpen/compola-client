import appIcon from '../../assets/app-icon.png';
import { Spinner } from '../../ui/Spinner';
import { BrandBackground } from './BrandBackground';

export const appName = 'Compola';

/** A splash while the client boots or signs in (Swift `SplashView`). */
export function SplashView({ message }: { message: string }) {
  return (
    <BrandBackground>
      <div className="splash fade-in">
        <img src={appIcon} width={84} height={84} alt="" draggable={false} />
        <div className="splash-name">{appName}</div>
        <div className="splash-status">
          <Spinner size={14} />
          <span>{message}</span>
        </div>
      </div>
    </BrandBackground>
  );
}
