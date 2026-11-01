import { Wrench } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export function DemoBanner() {
  const { isDemo, toggleDemo } = useAuth();

  if (!isDemo) return null;

  return (
    <div className="w-full px-4 py-2 flex items-center justify-center gap-2.5 text-[13px] font-semibold bg-amber-50 text-amber-800 border-b border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/50 z-50">
      <Wrench size={14} />
      <span>Demo Mode &mdash; Showing sample data only</span>
      <button
        type="button"
        onClick={toggleDemo}
        className="ml-1 px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider bg-amber-700 text-white hover:bg-amber-800 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300 transition-colors"
      >
        Exit Demo
      </button>
    </div>
  );
}
