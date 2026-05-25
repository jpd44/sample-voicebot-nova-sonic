#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const speechlab_stack_1 = require("../lib/speechlab-stack");
const app = new cdk.App();
new speechlab_stack_1.SpeechLabStack(app, 'SpeechLabStack', {
    // daily-deutsch account, anchored to us-east-1 so CloudFront can use the ACM cert here
    env: { account: '376210053828', region: 'us-east-1' },
    parentDomain: 'daily-deutsch.com',
    hostedZoneId: 'Z07189423NPO72TQYBDBS',
    subdomain: 'speechlab',
    desiredTaskCount: 1,
    budgetEmail: process.env.SPEECHLAB_ALERT_EMAIL,
    cognitoUserPoolId: 'us-east-1_dqBKmK639',
    cognitoClientId: '2uspue6gjg3dug6ugsprcj3u23',
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3BlZWNobGFiLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3BlZWNobGFiLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMsNERBQXdEO0FBRXhELE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLElBQUksZ0NBQWMsQ0FBQyxHQUFHLEVBQUUsZ0JBQWdCLEVBQUU7SUFDdEMsdUZBQXVGO0lBQ3ZGLEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRTtJQUNyRCxZQUFZLEVBQUUsbUJBQW1CO0lBQ2pDLFlBQVksRUFBRSx1QkFBdUI7SUFDckMsU0FBUyxFQUFFLFdBQVc7SUFDdEIsZ0JBQWdCLEVBQUUsQ0FBQztJQUNuQixXQUFXLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQkFBcUI7SUFDOUMsaUJBQWlCLEVBQUUscUJBQXFCO0lBQ3hDLGVBQWUsRUFBRSw0QkFBNEI7Q0FDaEQsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFNwZWVjaExhYlN0YWNrIH0gZnJvbSAnLi4vbGliL3NwZWVjaGxhYi1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbm5ldyBTcGVlY2hMYWJTdGFjayhhcHAsICdTcGVlY2hMYWJTdGFjaycsIHtcbiAgICAvLyBkYWlseS1kZXV0c2NoIGFjY291bnQsIGFuY2hvcmVkIHRvIHVzLWVhc3QtMSBzbyBDbG91ZEZyb250IGNhbiB1c2UgdGhlIEFDTSBjZXJ0IGhlcmVcbiAgICBlbnY6IHsgYWNjb3VudDogJzM3NjIxMDA1MzgyOCcsIHJlZ2lvbjogJ3VzLWVhc3QtMScgfSxcbiAgICBwYXJlbnREb21haW46ICdkYWlseS1kZXV0c2NoLmNvbScsXG4gICAgaG9zdGVkWm9uZUlkOiAnWjA3MTg5NDIzTlBPNzJUUVlCREJTJyxcbiAgICBzdWJkb21haW46ICdzcGVlY2hsYWInLFxuICAgIGRlc2lyZWRUYXNrQ291bnQ6IDEsXG4gICAgYnVkZ2V0RW1haWw6IHByb2Nlc3MuZW52LlNQRUVDSExBQl9BTEVSVF9FTUFJTCxcbiAgICBjb2duaXRvVXNlclBvb2xJZDogJ3VzLWVhc3QtMV9kcUJLbUs2MzknLFxuICAgIGNvZ25pdG9DbGllbnRJZDogJzJ1c3B1ZTZnamczZHVnNnVnc3ByY2ozdTIzJyxcbn0pO1xuIl19