// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  UserPool,
  CfnUserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  OAuthScope,
  ClientAttributes,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  CfnUserPoolUser,
} from "aws-cdk-lib/aws-cognito";
import { Effect, FederatedPrincipal, PolicyDocument, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Aws, ArnFormat, CfnResource, Duration, RemovalPolicy, Stack, CfnCondition, Fn } from "aws-cdk-lib";
import { CfnPolicy } from "aws-cdk-lib/aws-iot";
import { Construct } from "constructs";

/**
 * CognitoAuthConstruct props
 *
 * @interface CognitoAuthConstructProps
 */
export interface CognitoAuthConstructProps {
  adminEmail: string;
  adminName: string;
  apiId: string;
  cloudFrontDomainName: string;
  scenariosBucketArn: string;
  existingCognitoPoolId: string;
}

export class CognitoAuthConstruct extends Construct {
  cognitoIdentityPoolId: string;
  cognitoUserPoolClientId: string;
  cognitoUserPoolId: string;
  public iotPolicy: CfnPolicy;

  constructor(scope: Construct, id: string, props: CognitoAuthConstructProps) {
    super(scope, id);

    // CFN Conditions
    const createUserPoolResourceCondition = new CfnCondition(this, "createUserPoolResource", {
      expression: Fn.conditionEquals(props.existingCognitoPoolId, ""),
    });

    const dltIotPolicy = new CfnPolicy(this, "IoT-Policy", {
      policyDocument: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:Connect"],
            resources: [
              Stack.of(this).formatArn({
                service: "iot",
                resource: "client",
                resourceName: "*",
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              }),
            ],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:Subscribe"],
            resources: [
              Stack.of(this).formatArn({
                service: "iot",
                resource: "topicfilter",
                resourceName: "*",
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              }),
            ],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:Receive"],
            resources: [
              Stack.of(this).formatArn({
                service: "iot",
                resource: "topic",
                resourceName: "*",
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              }),
            ],
          }),
        ],
      }),
    });
    this.iotPolicy = dltIotPolicy;
    dltIotPolicy.addMetadata("cfn_nag", {
      rules_to_suppress: [
        {
          id: "W11",
          reason: "Cannot specify the resource to attach policy to identity",
        },
      ],
    });

    const cognitoUserPool = new UserPool(this, "DLTUserPool", {
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        requireUppercase: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
        username: true,
      },
      standardAttributes: {
        email: {
          required: true,
        },
      },
      userInvitation: {
        emailSubject: "Welcome to Distributed Load Testing",
        emailBody: `
                <p>
                   Please use the credentials below to login to the Distributed Load Testing console.
                </p>
                <p>
                    Username: <strong>{username}</strong>
                </p>
                <p>
                    Password: <strong>{####}</strong>
                </p>
                <p>
                    Console: <strong>https://${props.cloudFrontDomainName}/</strong>
                </p>
              `,
        smsMessage: "Your username is {username} and temporary password is {####}.",
      },
      userPoolName: `${Aws.STACK_NAME}-user-pool`,
    });
    (cognitoUserPool.node.defaultChild as CfnUserPool).userPoolAddOns = { advancedSecurityMode: "ENFORCED" };
    (cognitoUserPool.node.defaultChild as CfnUserPool).cfnOptions.condition = createUserPoolResourceCondition;

    this.cognitoUserPoolId = Fn.conditionIf(
      createUserPoolResourceCondition.logicalId,
      cognitoUserPool.userPoolId,
      props.existingCognitoPoolId
    ).toString();
    const userPool = UserPool.fromUserPoolId(this, "UserPool", this.cognitoUserPoolId);

    const clientWriteAttributes = new ClientAttributes().withStandardAttributes({
      address: true,
      email: true,
      phoneNumber: true,
    });

    const cognitoUserPoolClient = new UserPoolClient(this, "DLTUserPoolClient", {
      userPoolClientName: `${Aws.STACK_NAME}-userpool-client`,
      userPool,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.custom("AzureAD")],
      generateSecret: false,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE, OAuthScope.COGNITO_ADMIN],
        callbackUrls: [`https://${props.cloudFrontDomainName}/`],
        logoutUrls: [`https://${props.cloudFrontDomainName}/`],
      },
      writeAttributes: clientWriteAttributes,
      refreshTokenValidity: Duration.days(1),
    });

    this.cognitoUserPoolClientId = cognitoUserPoolClient.userPoolClientId;

    const cognitoIdentityPool = new CfnIdentityPool(this, "DLTIdentityPool", {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.cognitoUserPoolClientId,
          providerName: `cognito-idp.${userPool.env.region}.amazonaws.com/${userPool.userPoolId}`,
        },
      ],
    });

    this.cognitoIdentityPoolId = cognitoIdentityPool.ref;

    const apiProdExecuteArn = Stack.of(this).formatArn({
      service: "execute-api",
      resource: props.apiId,
      resourceName: "prod/*",
    });
    const cognitoAuthorizedRole = new Role(this, "DLTCognitoAuthorizedRole", {
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: { "cognito-identity.amazonaws.com:aud": this.cognitoIdentityPoolId },
          "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
      description: `${Aws.STACK_NAME} Identity Pool authenticated role`,
      inlinePolicies: {
        InvokeApiPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["execute-api:Invoke"],
              resources: [apiProdExecuteArn],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["s3:PutObject", "s3:GetObject"],
              resources: [`${props.scenariosBucketArn}/public/*`, `${props.scenariosBucketArn}/cloudWatchImages/*`],
            }),
          ],
        }),
        IoTPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["iot:AttachPrincipalPolicy"],
              resources: ["*"],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["iot:Connect"],
              resources: [
                Stack.of(this).formatArn({
                  service: "iot",
                  resource: "client",
                  resourceName: "*",
                  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["iot:Subscribe"],
              resources: [
                Stack.of(this).formatArn({
                  service: "iot",
                  resource: "topicfilter",
                  resourceName: "*",
                  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["iot:Receive"],
              resources: [
                Stack.of(this).formatArn({
                  service: "iot",
                  resource: "topic",
                  resourceName: "*",
                  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
          ],
        }),
      },
    });
    (cognitoAuthorizedRole.node.defaultChild as CfnResource).addMetadata("cfn_nag", {
      rules_to_suppress: [
        {
          id: "W11",
          reason: "iot:AttachPrincipalPolicy does not allow for resource specification",
        },
      ],
    });

    const cognitoUnauthorizedRole = new Role(this, "DLTCognitoUnauthorizedRole", {
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: { "cognito-identity.amazonaws.com:aud": this.cognitoIdentityPoolId },
          "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "unauthenticated" },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    new CfnIdentityPoolRoleAttachment(this, "CognitoAttachRole", {
      identityPoolId: this.cognitoIdentityPoolId,
      roles: {
        unauthenticated: cognitoUnauthorizedRole.roleArn,
        authenticated: cognitoAuthorizedRole.roleArn,
      },
    });

    new CfnUserPoolUser(this, "CognitoUser", {
      desiredDeliveryMediums: ["EMAIL"],
      forceAliasCreation: true,
      userAttributes: [
        { name: "email", value: props.adminEmail },
        { name: "nickname", value: props.adminName },
        { name: "email_verified", value: "true" },
      ],
      username: props.adminName,
      userPoolId: this.cognitoUserPoolId,
    });
  }
}
