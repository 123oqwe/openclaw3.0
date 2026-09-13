import { consume } from "@lit/context";
import type {
  OutcomeCreateParams,
  OutcomeCriterionInput,
  OutcomeDetail,
  OutcomeSummary,
} from "@openclaw/outcomes-contract";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import type { OutcomeGatewayIdentity, OutcomeMutationLock } from "./outcomes-page-model.ts";

export abstract class OutcomesPageState extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;

  @state() protected outcomes: OutcomeSummary[] = [];
  @state() protected disconnected = false;
  @state() protected unauthorized = false;
  @state() protected loading = false;
  @state() protected loaded = false;
  @state() protected error: string | null = null;
  @state() protected nextCursor: string | null = null;
  @state() protected loadingMore = false;
  @state() protected loadMoreError: string | null = null;
  @state() protected detail: OutcomeDetail | null = null;
  @state() protected detailError: string | null = null;
  @state() protected detailLoading = false;
  @state() protected detailRevalidating = false;
  @state() protected detailExpired = false;
  @state() protected cancelConfirmationOpen = false;
  @state() protected cancelError: string | null = null;
  @state() protected cancelling = false;
  @state() protected mutationError: string | null = null;
  @state() protected refreshing = false;
  @state() protected verificationDialogOpen = false;
  @state() protected verifying = false;
  @state() protected verificationError: string | null = null;
  @state() protected verificationCriterionId = "";
  @state() protected verificationStatus: "verified" | "rejected" = "verified";
  @state() protected verificationNote = "";
  @state() protected selectedOutcomeId: string | null = null;
  @state() protected mutationInFlightOutcomeLocks: readonly OutcomeMutationLock[] = [];
  @state() protected createDialogOpen = false;
  @state() protected creating = false;
  @state() protected createError: string | null = null;
  @state() protected createTitle = "";
  @state() protected createObjective = "";
  @state() protected createCriteria: readonly string[] = [""];
  @state() protected editDialogOpen = false;
  @state() protected editing = false;
  @state() protected editError: string | null = null;
  @state() protected editTitle = "";
  @state() protected editObjective = "";
  @state() protected editCriteria: readonly OutcomeCriterionInput[] = [];
  @state() protected linkDialogOpen = false;
  @state() protected linking = false;
  @state() protected linkError: string | null = null;
  @state() protected linkCards: readonly WorkboardCard[] = [];
  @state() protected linkCardsLoading = false;
  @state() protected linkCriterionId = "";
  @state() protected linkCardId = "";

  protected requestGeneration = 0;
  protected detailRequestSequence = 0;
  protected mutationSequence = 0;
  protected outcomeMutationLockSequence = 0;
  protected createRequestSequence = 0;
  protected editRequestSequence = 0;
  protected linkRequestSequence = 0;
  protected assuranceRequestSequence = 0;
  protected createRequest: OutcomeCreateParams | null = null;
  protected gatewayIdentity: OutcomeGatewayIdentity | null = null;
  protected pendingListFocusId: string | null = null;
  protected pendingCreateFocus = false;
  protected detailFreshnessDeadline: number | null = null;
  protected detailFreshnessTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
}
