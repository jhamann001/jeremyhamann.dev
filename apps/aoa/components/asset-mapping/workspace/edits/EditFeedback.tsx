import { Button } from "@/components/ui";
import { EDIT_COPY } from "./edit-model";
import styles from "../AssetMappingWorkspace.module.css";

export function EditFailureText({ text }: { text: string }) {
  return <span role="alert" className={styles.editError}>{text}</span>;
}

export function UndoBar({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <div role="status" aria-live="polite" className={styles.undoBar}>
      <span>{message}</span>
      <Button size="sm" variant="ghost" onClick={onUndo}>{EDIT_COPY.undo}</Button>
    </div>
  );
}
