import { GitMergeIcon, LoaderCircleIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type DeliveryMergeConfirmationProps = {
  readonly actionId: string;
  readonly branch: string;
  readonly decisionSequence: number;
  readonly disabled: boolean;
  readonly headSha: string;
  readonly method: "merge" | "rebase" | "squash";
  readonly onConfirm: () => Promise<void>;
  readonly pending: boolean;
  readonly prUrl: string;
  readonly error?: string;
};

export function DeliveryMergeConfirmation(
  props: DeliveryMergeConfirmationProps
) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submissionError, setSubmissionError] = React.useState<string>();
  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setSubmissionError(undefined);
    try {
      await props.onConfirm();
      setOpen(false);
    } catch {
      setSubmissionError(
        props.error ??
          "Merge action was not accepted. Refresh readiness and retry safely."
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={<Button disabled={props.disabled || props.pending} size="sm" />}
      >
        <GitMergeIcon data-icon="inline-start" />
        Merge pull request
      </DialogTrigger>
      <DialogContent data-testid="delivery-merge-confirmation">
        <DialogHeader>
          <DialogTitle>Confirm exact-head merge</DialogTitle>
          <DialogDescription>
            Gaia will freshly verify required checks, reviews, threads, and
            mergeability before recording merge intent.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-muted-foreground">Pull request</dt>
          <dd className="min-w-0 font-medium break-all">{props.prUrl}</dd>
          <dt className="text-muted-foreground">Branch</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {props.branch}
          </dd>
          <dt className="text-muted-foreground">Exact head</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {props.headSha}
          </dd>
          <dt className="text-muted-foreground">Method</dt>
          <dd className="capitalize">{props.method}</dd>
          <dt className="text-muted-foreground">Readiness</dt>
          <dd className="font-mono text-xs">
            Sequence {props.decisionSequence}
          </dd>
          <dt className="text-muted-foreground">Action</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {props.actionId}
          </dd>
        </dl>
        {submissionError === undefined && props.error === undefined ? null : (
          <p className="text-sm text-destructive" role="alert">
            {submissionError ?? props.error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={props.pending || submitting}
            onClick={() => void confirm()}
          >
            {props.pending || submitting ? (
              <LoaderCircleIcon
                className="animate-spin"
                data-icon="inline-start"
              />
            ) : (
              <GitMergeIcon data-icon="inline-start" />
            )}
            Confirm {props.method} merge
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
