import type {
  NetworkPermissionPayload,
  NetworkPermissionValues,
  PermissionInput,
  PermissionOutputPayload,
} from "./interface";

const permissionIntroOutputNode = workflow.createOutputNode<PermissionInput>({
  name: "permission-intro-output",
  metadata: {
    type: "permission-intro-output",
    title: "Permission Intro Output",
    version: "1.0.0",
  },
  format() {
    return createPlainTextOutput("下面需要请求网络访问权限，请你同意开启");
  },
});

const permissionRequestNode = workflow.createUserInputNode<PermissionInput, NetworkPermissionPayload>({
  name: "network-permission",
  title: "请求网络访问权限",
  description: "当前 workflow 需要访问网络，请确认是否同意开启。",
  params: [
    {
      name: "allowed",
      flag: "--allowed",
      type: "boolean",
      required: true,
      defaultValue: "false",
      description: "同意开启网络访问权限。",
    },
  ],
  defaultValues: {
    allowed: false,
  },
  metadata: {
    type: "network-permission",
    title: "Network Permission",
    version: "1.0.0",
  },
  format(payload) {
    return {
      errCode: 0,
      errMessage: "",
      requestId: payload.requestId,
      values: normalizePermissionValues(payload.values),
      submittedAt: payload.submittedAt,
    };
  },
});

const permissionGrantedOutputNode = workflow.createOutputNode<
  PermissionInput & { permission: NetworkPermissionPayload },
  PermissionOutputPayload
>({
  name: "permission-granted-output",
  metadata: {
    type: "permission-granted-output",
    title: "Permission Granted Output",
    version: "1.0.0",
  },
  format(input) {
    return createPermissionOutput({
      allowed: true,
      message: "成功获取权限",
      requestId: input.permission.requestId,
      submittedAt: input.permission.submittedAt,
    });
  },
});

const permissionDeniedOutputNode = workflow.createOutputNode<
  PermissionInput & { permission: NetworkPermissionPayload },
  PermissionOutputPayload
>({
  name: "permission-denied-output",
  metadata: {
    type: "permission-denied-output",
    title: "Permission Denied Output",
    version: "1.0.0",
  },
  format(input) {
    return createPermissionOutput({
      allowed: false,
      message: "获取权限失败",
      requestId: input.permission.requestId,
      submittedAt: input.permission.submittedAt,
    });
  },
});

export const humanInputWorkflow = workflow.defineWorkflow<PermissionInput, PermissionOutputPayload>({
  name: "human-input",
  async run(input, context) {
    // Demonstrates a durable permission prompt: text first, then a
    // resumable human decision, then a visible success/failure output branch.
    await workflow.runNode(permissionIntroOutputNode, input, context);
    const permission = await workflow.runNode(permissionRequestNode, input, context);
    return workflow.runIf({ ...input, permission }, context, {
      name: "网络权限判断",
      branches: [
        {
          label: "同意",
          condition: (state) => state.permission.values.allowed,
          run: (state, branchContext) => workflow.runNode(permissionGrantedOutputNode, state, branchContext),
        },
      ],
      else: {
        label: "不同意",
        run: (state, branchContext) => workflow.runNode(permissionDeniedOutputNode, state, branchContext),
      },
    });
  },
});

export const executor = workflow.defineExecutor<
  PermissionInput,
  PermissionOutputPayload
>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<PermissionInput, PermissionOutputPayload>({
      id: "main",
      title: "Human Input",
      workflow: humanInputWorkflow,
      params: [],
      createInput() {
        return {
          requestedAt: new Date().toISOString(),
        };
      },
    }),
  ],
});

export { humanInputWorkflow as workflow };
export default humanInputWorkflow;

function normalizePermissionValues(values: Record<string, unknown>): NetworkPermissionValues {
  return {
    allowed: values["allowed"] === true,
  };
}

function createPermissionOutput(options: {
  allowed: boolean;
  message: string;
  requestId: string;
  submittedAt: string;
}): PermissionOutputPayload {
  return {
    ...createPlainTextOutput(options.message),
    allowed: options.allowed,
    message: options.message,
    requestId: options.requestId,
    submittedAt: options.submittedAt,
  };
}

function createPlainTextOutput(content: string) {
  // Keep the permission sample inline: custom titles/icons render as details blocks.
  return workflow.createOutputPayload({
    items: [
      {
        title: "Output",
        content,
        contentType: "text",
      },
    ],
  });
}
