let CloudWatchLogs = require("@aws-sdk/client-cloudwatch-logs")
let KMS = require("@aws-sdk/client-kms")
let url = require("url")
import { request } from "https"
let config = require("./config")
let _ = require("lodash")
let escapeStringRegexp = require("escape-string-regexp")
let hookUrl: string

import { Context, SNSEvent, Callback, SNSEventRecord } from "aws-lambda";

let channel = config.slackChannel

let baseSlackMessage = {
    channel: channel,
    attachments: [
        {
            fields: config.mention
                ? [{ title: "Mention", value: config.mention, short: true }]
                : [],
        },
    ],
}

let deliverMessage = function(message: object, callback: (o: object) => void) {
    let body = JSON.stringify(message)
    let options = url.parse(hookUrl)
    options.method = "POST"
    options.headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    }

    let postReq = request(options, function(res) {
        let chunks: string[] = []
        res.setEncoding("utf8")
        res.on("data", function(chunk) {
            return chunks.push(chunk)
        })
        res.on("end", function() {
            let body = chunks.join("")
            if (callback) {
                callback({
                    body: body,
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                })
            }
        })
        return res
    })

    postReq.write(body)
    postReq.end()
}

let handleElasticBeanstalk = function(event: SNSEvent, context: Context) {
    let timestamp = new Date(event.Records[0].Sns.Timestamp).getTime() / 1000
    let subject =
        event.Records[0].Sns.Subject || "AWS Elastic Beanstalk Notification"
    let message = event.Records[0].Sns.Message

    let stateRed = message.indexOf(" to RED")
    let stateSevere = message.indexOf(" to Severe")
    let butWithErrors = message.indexOf(" but with errors")
    let noPermission = message.indexOf("You do not have permission")
    let failedDeploy = message.indexOf("Failed to deploy application")
    let failedConfig = message.indexOf("Failed to deploy configuration")
    let failedQuota = message.indexOf(
        "Your quota allows for 0 more running instance"
    )
    let unsuccessfulCommand = message.indexOf("Unsuccessful command execution")

    let stateYellow = message.indexOf(" to YELLOW")
    let stateDegraded = message.indexOf(" to Degraded")
    let stateInfo = message.indexOf(" to Info")
    let removedInstance = message.indexOf("Removed instance ")
    let addingInstance = message.indexOf("Adding instance ")
    let abortedOperation = message.indexOf(" aborted operation.")
    let abortedDeployment = message.indexOf(
        "some instances may have deployed the new application version"
    )

    let color = "good"

    if (
        stateRed != -1 ||
        stateSevere != -1 ||
        butWithErrors != -1 ||
        noPermission != -1 ||
        failedDeploy != -1 ||
        failedConfig != -1 ||
        failedQuota != -1 ||
        unsuccessfulCommand != -1
    ) {
        color = "danger"
    }
    if (
        stateYellow != -1 ||
        stateDegraded != -1 ||
        stateInfo != -1 ||
        removedInstance != -1 ||
        addingInstance != -1 ||
        abortedOperation != -1 ||
        abortedDeployment != -1
    ) {
        color = "warning"
    }

    let slackMessage = {
        text: "*" + subject + "*",
        attachments: [
            {
                fields: [
                    {
                        title: "Subject",
                        value: event.Records[0].Sns.Subject,
                        short: false,
                    },
                    { title: "Message", value: message, short: false },
                ],
                color: color,
                ts: timestamp,
            },
        ],
    }

    return Promise.resolve(_.merge(slackMessage, baseSlackMessage))
}

let handleCodeDeploy = function(event: SNSEvent, context: Context) {
    let subject = "AWS CodeDeploy Notification"
    let timestamp = new Date(event.Records[0].Sns.Timestamp).getTime() / 1000
    let snsSubject = event.Records[0].Sns.Subject
    let message
    let fields: object[] = []
    let color = "warning"

    try {
        message = JSON.parse(event.Records[0].Sns.Message)

        if (message.status === "SUCCEEDED") {
            color = "good"
        } else if (message.status === "FAILED") {
            color = "danger"
        }
        fields.push({ title: "Message", value: snsSubject, short: false })
        fields.push({
            title: "Deployment Group",
            value: message.deploymentGroupName,
            short: true,
        })
        fields.push({
            title: "Application",
            value: message.applicationName,
            short: true,
        })
        fields.push({
            title: "Status Link",
            value:
                "https://console.aws.amazon.com/codedeploy/home?region=" +
                message.region +
                "#/deployments/" +
                message.deploymentId,
            short: false,
        })
    } catch (e) {
        color = "good"
        message = event.Records[0].Sns.Message
        fields.push({ title: "Message", value: snsSubject, short: false })
        fields.push({ title: "Detail", value: message, short: false })
    }

    let slackMessage = {
        text: "*" + subject + "*",
        attachments: [
            {
                color: color,
                fields: fields,
                ts: timestamp,
            },
        ],
    }

    return Promise.resolve(_.merge(slackMessage, baseSlackMessage))
}

let handleCodePipeline = function(event: SNSEvent, context: Context) {
    let subject = "AWS CodePipeline Notification"
    let timestamp = new Date(event.Records[0].Sns.Timestamp).getTime() / 1000
    let snsSubject = event.Records[0].Sns.Subject
    let message: object
    let fields: object[] = []
    let color = "warning"
    let changeType = ""

    try {
        message = JSON.parse(event.Records[0].Sns.Message)
        let detailType = message["detail-type"]

        if (detailType === "CodePipeline Pipeline Execution State Change") {
            changeType = ""
        } else if (detailType === "CodePipeline Stage Execution State Change") {
            changeType = "STAGE " + message.detail.stage
        } else if (
            detailType === "CodePipeline Action Execution State Change"
        ) {
            changeType = "ACTION"
        }

        if (message.detail.state === "SUCCEEDED") {
            color = "good"
        } else if (message.detail.state === "FAILED") {
            color = "danger"
        }
        let header = message.detail.state + ": CodePipeline " + changeType
        fields.push({ title: "Message", value: header, short: false })
        fields.push({
            title: "Pipeline",
            value: message.detail.pipeline,
            short: true,
        })
        fields.push({ title: "Region", value: message.region, short: true })
        fields.push({
            title: "Status Link",
            value:
                "https://console.aws.amazon.com/codepipeline/home?region=" +
                message.region +
                "#/view/" +
                message.detail.pipeline,
            short: false,
        })
    } catch (e) {
        color = "good"
        message = JSON.parse(event.Records[0].Sns.Message)
        let header =
            message.detail.state + ": CodePipeline " + message.detail.pipeline
        fields.push({ title: "Message", value: header, short: false })
        fields.push({ title: "Detail", value: message, short: false })
    }

    let slackMessage = {
        text: "*" + subject + "*",
        attachments: [
            {
                color: color,
                fields: fields,
                ts: timestamp,
            },
        ],
    }

    return Promise.resolve(_.merge(slackMessage, baseSlackMessage))
}

function recordTimestamp(record: SNSEventRecord): number {
    return new Date(record.Sns.Timestamp).getTime() / 1000
}

let handleElasticache = function(event: SNSEvent, context: Context) {
    let message = JSON.parse(event.Records[0].Sns.Message)
    let region = event.Records[0].EventSubscriptionArn.split(":")[3]
    let eventname, nodename
    let color = "good"

    for (let key in message) {
        eventname = key
        nodename = message[key]
        break
    }
    let slackMessage = {
        text: "*AWS ElastiCache Notification*",
        attachments: [
            {
                color: color,
                fields: [
                    {
                        title: "Event",
                        value: eventname.split(":")[1],
                        short: true,
                    },
                    { title: "Node", value: nodename, short: true },
                    {
                        title: "Link to cache node",
                        value:
                            "https://console.aws.amazon.com/elasticache/home?region=" +
                            region +
                            "#cache-nodes:id=" +
                            nodename +
                            ";nodes",
                        short: false,
                    },
                ],
                ts: recordTimestamp(event.Records[0]),
            },
        ],
    }
    return Promise.resolve(_.merge(slackMessage, baseSlackMessage))
}

let handleHealthCheck = function(event: SNSEvent, context: Context) {
    let timestamp = new Date(event.Records[0].Sns.Timestamp).getTime() / 1000
    let message = JSON.parse(event.Records[0].Sns.Message)
    let region = event.Records[0].EventSubscriptionArn.split(":")[3]
    let subject = "AWS CloudWatch Notification"
    let alarmName = message.AlarmName
    let color = "warning"
    let customMessage = "Monitor is "

    if (message.NewStateValue === "ALARM") {
        color = "danger"
        customMessage += "*DOWN*: "
    } else if (message.NewStateValue === "OK") {
        color = "good"
        customMessage += "*UP*: "
    }
    customMessage += alarmName.split("-awsroute53-")[0]

    let slackMessage = {
        text: "*" + subject + "*",
        attachments: [
            {
                title: alarmName,
                title_link:
                    "https://console.aws.amazon.com/cloudwatch/home?region=" +
                    region +
                    "#alarm:alarmFilter=ANY;name=" +
                    encodeURIComponent(alarmName),
                color: color,
                fields: [{ value: customMessage, short: false }],
                footer_icon:
                    "https://d0.awsstatic.com/logos/Services/aws-icons_12_amazon-cloudwatch.png",
                ts: timestamp,
            },
        ],
    }
    return _.merge(slackMessage, baseSlackMessage)
}

let handleCloudWatch = function(event: SNSEvent, context: Context) {
    let timestamp = new Date(event.Records[0].Sns.Timestamp).getTime() / 1000
    let message = JSON.parse(event.Records[0].Sns.Message)
    let region = event.Records[0].EventSubscriptionArn.split(":")[3]
    let subject = "AWS CloudWatch Notification"
    let alarmName = message.AlarmName

    let metricName = message.Trigger.MetricName
    let metricNamespace = message.Trigger.Namespace

    let trigger = message.Trigger
    let alarmExpression: string

    if (typeof trigger.Metrics === "object") {
        // This is a CloudWatch metric math alarm. Instead of a MetricName and
        // statistic there is an array of Metrics where the first element is the
        // math expression. Need to process each metric in the list of Metrics
        // and replace occurences of it in the alarm expression
        alarmExpression = trigger.Metrics[0].Expression
        let triggerMetricsLength = trigger.Metrics.length
        for (let i = 1; i < triggerMetricsLength; i++) {
            let metric = trigger.Metrics[i]
            alarmExpression = alarmExpression.replace(
                new RegExp(escapeStringRegexp(metric.Id), "g"),
                metric.MetricStat.Stat +
                ":" +
                metric.MetricStat.Metric.MetricName
            )
        }
    } else {
        // This is a standard CloudWatch alarm on a single metric
        alarmExpression = trigger.Statistic + ":" + trigger.MetricName
    }

    let oldState = message.OldStateValue
    let newState = message.NewStateValue
    let alarmDescription = message.AlarmDescription
    let color = "warning"
    let logs = new CloudWatchLogs.CloudWatchLogsClient({ region: region })

    let metricFilters = logs.send(
        new CloudWatchLogs.DescribeMetricFiltersCommand({
            metricName: metricName,
            metricNamespace: metricNamespace,
        })
    )

    return metricFilters.then((data) => {
        if (message.NewStateValue === "ALARM") {
            color = "danger"
        } else if (message.NewStateValue === "OK") {
            color = "good"
        }

        let cloudwatchURLBase =
            "https://console.aws.amazon.com/cloudwatch/home?region=" + region

        let logGroupLinks = data.metricFilters.map((filter) => ({
            title: filter.filterName + " logs source",
            value:
                cloudwatchURLBase +
                "#logEventViewer:group=" +
                encodeURIComponent(filter.logGroupName) +
                ";filter=" +
                encodeURIComponent(filter.filterPattern) +
                ";start=PT" +
                trigger.Period +
                "S",
            short: false,
        }))

        let slackMessage = {
            text: "*" + subject + "*",
            attachments: [
                {
                    color: color,
                    fields: [
                        { title: "Alarm Name", value: alarmName, short: true },
                        {
                            title: "Alarm Description",
                            value: alarmDescription,
                            short: false,
                        },
                        {
                            title: "Trigger",
                            value:
                                alarmExpression +
                                " " +
                                trigger.ComparisonOperator +
                                " " +
                                trigger.Threshold +
                                " for " +
                                trigger.EvaluationPeriods +
                                " period(s) of " +
                                trigger.Period +
                                " seconds.",
                            short: false,
                        },
                        { title: "Old State", value: oldState, short: true },
                        {
                            title: "Current State",
                            value: newState,
                            short: true,
                        },
                        {
                            title: "Link to Alarm",
                            value:
                                cloudwatchURLBase +
                                "#alarm:alarmFilter=ANY;name=" +
                                encodeURIComponent(alarmName),
                            short: false,
                        },
                    ].concat(logGroupLinks),
                    ts: timestamp,
                },
            ],
        }
        return _.merge(slackMessage, baseSlackMessage)
    })
}

let handleAutoScaling = function(event: SNSEvent, context: Context) {
    let subject = "AWS AutoScaling Notification"
    let message = JSON.parse(event.Records[0].Sns.Message)
    let timestamp = new Date(event.Records[0].Sns.Timestamp).getTime() / 1000
    let eventname, nodename
    let color = "good"

    for (let key in message) {
        eventname = key
        nodename = message[key]
        break
    }
    let slackMessage = {
        text: "*" + subject + "*",
        attachments: [
            {
                color: color,
                fields: [
                    {
                        title: "Message",
                        value: event.Records[0].Sns.Subject,
                        short: false,
                    },
                    {
                        title: "Description",
                        value: message.Description,
                        short: false,
                    },
                    { title: "Event", value: message.Event, short: false },
                    { title: "Cause", value: message.Cause, short: false },
                ],
                ts: timestamp,
            },
        ],
    }
    return Promise.resolve(_.merge(slackMessage, baseSlackMessage))
}

let handleCatchAll = function(event: SNSEvent, context: Context) {
    let record = event.Records[0]
    let subject = record.Sns.Subject
    let timestamp = new Date(record.Sns.Timestamp).getTime() / 1000
    let message = JSON.parse(record.Sns.Message)
    let color = "warning"

    if (message.NewStateValue === "ALARM") {
        color = "danger"
    } else if (message.NewStateValue === "OK") {
        color = "good"
    }

    // Add all of the values from the event message to the Slack message description
    let description = ""
    for (let key in message) {
        let renderedMessage =
            typeof message[key] === "object"
                ? JSON.stringify(message[key])
                : message[key]

        description = description + "\n" + key + ": " + renderedMessage
    }

    let slackMessage = {
        text: "*" + subject + "*",
        attachments: [
            {
                color: color,
                fields: [
                    {
                        title: "Message",
                        value: record.Sns.Subject,
                        short: false,
                    },
                    { title: "Description", value: description, short: false },
                ],
                ts: timestamp,
            },
        ],
    }

    return Promise.resolve(_.merge(slackMessage, baseSlackMessage))
}

function eventContains(event: SNSEventRecord, text: string): boolean {
    let eventSubscriptionArn = event.EventSubscriptionArn
    let eventSnsSubject = event.Sns.Subject || "no subject"
    let eventSnsMessageRaw = event.Sns.Message

    return eventSubscriptionArn.indexOf(text) > 1 ||
        eventSnsSubject.indexOf(text) > -1 ||
        eventSnsMessageRaw.indexOf(text) > -1
}

function tryJSON(data: string | null): object | null {
    try {
        return JSON.parse(data);
    } catch {
        return null
    }
}

let processEvent = function(event: SNSEvent, context: Context, callback: Callback) {
    console.log("sns received:" + JSON.stringify(event, null, 2))
    let slackMessage: Promise<object>
    let record = event.Records[0]

    let snsMessage = tryJSON(record.Sns.Message)
    if (snsMessage && "AlarmName" in snsMessage && "AlarmDescription" in snsMessage) {
        console.log("processing cloudwatch notification")
        slackMessage = handleCloudWatch(event, context)
    } else if (eventContains(record, config.services.healthcheck.match_text)) {
        console.log("processing route53 healthcheck notification")
        slackMessage = handleHealthCheck(event, context)
    } else if (eventContains(record, config.services.codepipeline.match_text)) {
        console.log("processing codepipeline notification")
        slackMessage = handleCodePipeline(event, context)
    } else if (eventContains(record, config.services.elasticbeanstalk.match_text)) {
        console.log("processing elasticbeanstalk notification")
        slackMessage = handleElasticBeanstalk(event, context)
    } else if (eventContains(record, config.services.codedeploy.match_text)) {
        console.log("processing codedeploy notification")
        slackMessage = handleCodeDeploy(event, context)
    } else if (eventContains(record, config.services.elasticache.match_text)) {
        console.log("processing elasticache notification")
        slackMessage = handleElasticache(event, context)
    } else if (eventContains(record, config.services.autoscaling.match_text)) {
        console.log("processing autoscaling notification")
        slackMessage = handleAutoScaling(event, context)
    } else {
        slackMessage = handleCatchAll(event, context)
    }

    slackMessage.then((message: any) => {
        deliverMessage(message, function(response: any) {
            if (response.statusCode < 400) {
                console.info("message posted successfully")
                callback(null)
            } else if (response.statusCode < 500) {
                console.error(
                    "error posting message to slack API: " +
                    response.statusCode +
                    " - " +
                    response.statusMessage
                )
                // Don't retry because the error is due to a problem with the request
                callback(null)
            } else {
                // Let Lambda retry
                callback(
                    "server error when processing message: " +
                    response.statusCode +
                    " - " +
                    response.statusMessage
                )
            }
        })
    })
}

exports.handler = function(event: SNSEvent, context: Context, callback: Callback) {
    if (hookUrl) {
        processEvent(event, context, callback)
    } else if (config.unencryptedHookUrl) {
        hookUrl = config.unencryptedHookUrl
        processEvent(event, context, callback)
    } else if (
        config.kmsEncryptedHookUrl &&
        config.kmsEncryptedHookUrl !== "<kmsEncryptedHookUrl>"
    ) {
        let encryptedBuf = new Buffer(config.kmsEncryptedHookUrl, "base64")
        let cipherText = { CiphertextBlob: encryptedBuf }

        let region = JSON.parse(event.Records[0].Sns.Message).region
        let kmsClient = new KMS.KMSClient({ region })
        let cmd = new KMS.DecryptCommand({
            CiphertextBlob: cipherText,
        })
        kmsClient
            .send(cmd)
            .then(function(data) {
                hookUrl = "https://" + data.Plaintext.toString("ascii")
                processEvent(event, context, callback)
            })
            .catch(function(err) {
                console.log("decrypt error: " + err)
                processEvent(event, context, callback)
            })
    } else {
        callback("hook url has not been set.")
    }
}
