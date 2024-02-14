// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Template } from "aws-cdk-lib/assertions";
import { App, Aws, CfnCondition, DefaultStackSynthesizer, Fn, Stack } from "aws-cdk-lib";
import { DLTConsoleConstruct } from "../lib/front-end/console";
import { Bucket } from "aws-cdk-lib/aws-s3";

test("DLT API Test", () => {
  const app = new App();
  const stack = new Stack(app, "DLTStack", {
    synthesizer: new DefaultStackSynthesizer({
      generateBootstrapVersionRule: false,
    }),
  });
  const testSourceBucket = new Bucket(stack, "testSourceCodeBucket");
  const alwaysFalse = new CfnCondition(stack, "BoolCloudFrontCertificate", {
    expression: Fn.conditionEquals("something", "false"),
  });

  const console = new DLTConsoleConstruct(stack, "TestConsoleResources", {
    s3LogsBucket: testSourceBucket,
    solutionId: "testId",
    // cdk-lib doesn't see Aws.NO_VALUE as "not a certificate", so we need to pass a domain name.
    // This is not a problem if you use a cfnParameter that is a list.
    // In this specific case (with an alias but without a certificate), the actual template is not deployable
    cloudFrontAliases: ["www.example.com"],
    cloudFrontCertificateArn: Aws.NO_VALUE,
    sslSupportMethod: Aws.NO_VALUE,
    cloudFrontDefaultCertificate: "true",
  });

  expect(Template.fromStack(stack)).toMatchSnapshot();
  expect(console.cloudFrontDomainName).toBeDefined();
  expect(console.consoleBucket).toBeDefined();
  expect(console.consoleBucketArn).toBeDefined();
});
