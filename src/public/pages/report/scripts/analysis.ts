let ongoingEvaluation = false;

let evaluatedPositions: Position[] = [];
let reportResults: Report | undefined;

function logAnalysisInfo(message: string) {
    $("#status-message").css("color", "white");
    $("#status-message").html(message);
}

function logAnalysisError(message: string) {
    $("#secondary-message").html("");
    $("#status-message").css("color", "rgb(255, 53, 53)");
    $("#status-message").html(message);

    ongoingEvaluation = false;
}

async function evaluate() {
    // Remove and reset CAPTCHA, remove report cards, display progress bar
    $(".g-recaptcha").css("display", "none");
    grecaptcha.reset();

    $("#report-cards").css("display", "none");
    $("#evaluation-progress-bar").css("display", "inline");

    // Disallow evaluation if another evaluation is ongoing
    if (ongoingEvaluation) return;
    ongoingEvaluation = true;

    // Extract input PGN and target depth
    let pgn = $("#pgn").val()!.toString();
    let depth = parseInt($("#depth-slider").val()!.toString());

    // Content validate PGN input
    if (pgn.length == 0) {
        return logAnalysisError("Provide a game to analyse.");
    }

    // Post PGN to server to have it parsed
    logAnalysisInfo("Parsing PGN...");

    try {
        let parseResponse = await fetch("/api/parse", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ pgn }),
        });

        let parsedPGN: ParseResponse = await parseResponse.json();

        if (!parseResponse.ok) {
            return logAnalysisError(
                parsedPGN.message ?? "Failed to parse PGN.",
            );
        }

        var positions = parsedPGN.positions!;
    } catch (err) {
        return logAnalysisError("Failed to parse PGN.");
    }

    // Update board player usernames
    whitePlayer.username =
        pgn.match(/(?:\[White ")(.+)(?="\])/)?.[1] ?? "White Player";
    whitePlayer.rating = pgn.match(/(?:\[WhiteElo ")(.+)(?="\])/)?.[1] ?? "?";

    blackPlayer.username =
        pgn.match(/(?:\[Black ")(.+)(?="\])/)?.[1] ?? "Black Player";
    blackPlayer.rating = pgn.match(/(?:\[BlackElo ")(.+)(?="\])/)?.[1] ?? "?";

    updateBoardPlayers();

    $("#secondary-message").html(
        "It can take around a minute to process a full game.",
    );

    // Fetch cloud evaluations where possible
    for (let position of positions) {
        function placeCutoff() {
            let lastPosition = positions[positions.indexOf(position) - 1];
            if (!lastPosition) return;

            let cutoffWorker = new Stockfish();
            cutoffWorker
                .evaluate(lastPosition.fen, depth)
                .then((engineLines) => {
                    lastPosition.cutoffEvaluation = engineLines.find(
                        (line) => line.id == 1,
                    )?.evaluation ?? { type: "cp", value: 0 };
                });
        }

        let queryFen = position.fen.replace(/\s/g, "%20");
        let cloudEvaluationResponse;
        try {
            cloudEvaluationResponse = await fetch(
                `https://lichess.org/api/cloud-eval?fen=${queryFen}&multiPv=2`,
                {
                    method: "GET",
                },
            );

            if (!cloudEvaluationResponse) break;
        } catch (err) {
            break;
        }

        if (!cloudEvaluationResponse.ok) {
            placeCutoff();
            break;
        }

        let cloudEvaluation = await cloudEvaluationResponse.json();

        position.topLines = cloudEvaluation.pvs.map((pv: any, id: number) => {
            const evaluationType = pv.cp == undefined ? "mate" : "cp";
            const evaluationScore = pv.cp ?? pv.mate ?? "cp";

            let line: EngineLine = {
                id: id + 1,
                depth: depth,
                moveUCI: pv.moves.split(" ")[0] ?? "",
                evaluation: {
                    type: evaluationType,
                    value: evaluationScore,
                },
            };

            let cloudUCIFixes: { [key: string]: string } = {
                e8h8: "e8g8",
                e1h1: "e1g1",
                e8a8: "e8c8",
                e1a1: "e1c1",
            };
            line.moveUCI = cloudUCIFixes[line.moveUCI] ?? line.moveUCI;

            return line;
        });

        if (position.topLines?.length != 2) {
            placeCutoff();
            break;
        }

        position.worker = "cloud";

        let progress =
            ((positions.indexOf(position) + 1) / positions.length) * 100;
        $("#evaluation-progress-bar").attr("value", progress);
        logAnalysisInfo(`Evaluating positions... (${progress.toFixed(1)}%)`);
    }

    // Evaluate remaining positions
    let workerCount = 0;

    const stockfishManager = setInterval(() => {
        // If all evaluations have been generated, move on
        if (!positions.some((pos) => !pos.topLines)) {
            clearInterval(stockfishManager);

            logAnalysisInfo("Evaluation complete.");
            $("#evaluation-progress-bar").val(100);
            $(".g-recaptcha").css("display", "inline");
            $("#secondary-message").html(
                "Please complete the CAPTCHA to continue.",
            );

            evaluatedPositions = positions;
            ongoingEvaluation = false;

            return;
        }

        // Find next position with no worker and add new one
        for (let position of positions) {
            if (position.worker || workerCount >= 8) continue;

            let worker = new Stockfish();
            worker.evaluate(position.fen, depth).then((engineLines) => {
                position.topLines = engineLines;
                workerCount--;
            });

            position.worker = worker;
            workerCount++;
        }

        // Update progress monitor
        let workerDepths = 0;
        for (let position of positions) {
            if (typeof position.worker == "object") {
                workerDepths += position.worker.depth;
            } else if (typeof position.worker == "string") {
                workerDepths += depth;
            }
        }

        let progress = (workerDepths / (positions.length * depth)) * 100;

        $("#evaluation-progress-bar").attr("value", progress);
        logAnalysisInfo(`Evaluating positions... (${progress.toFixed(1)}%)`);
    }, 10);
}

async function report() {
    // Remove CAPTCHA
    $(".g-recaptcha").css("display", "none");
    $("#secondary-message").html("");
    $("#evaluation-progress-bar").attr("value", null);
    logAnalysisInfo("Generating report...");

    // Post evaluations and get report results
    try {
        let reportResponse = await fetch("/api/report", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                positions: evaluatedPositions.map((pos) => {
                    if (pos.worker != "cloud") {
                        pos.worker = "local";
                    }
                    return pos;
                }),
                captchaToken: grecaptcha.getResponse() || "none",
            }),
        });

        let report: ReportResponse = await reportResponse.json();

        if (!reportResponse.ok) {
            return logAnalysisError(
                report.message ?? "Failed to generate report.",
            );
        }

        // Set report results to results given by server
        reportResults = report.results!;

        // Reset chess board, draw evaluation for starting position
        traverseMoves(-Infinity);

        // Reveal report cards and update accuracies
        $("#report-cards").css("display", "flex");
        $("#white-accuracy").html(
            `${reportResults.accuracies.white ?? "100"}%`,
        );
        $("#black-accuracy").html(
            `${reportResults.accuracies.black ?? "100"}%`,
        );

        // Remove progress bar and any status message
        $("#evaluation-progress-bar").css("display", "none");
        logAnalysisInfo("");
    } catch (err) {
        return logAnalysisError("Failed to generate report.");
    }
}

$("#review-button").on("click", evaluate);

$("#depth-slider").on("input", () => {
    let depth = parseInt($("#depth-slider").val()?.toString()!);

    if (depth <= 14) {
        $("#depth-counter").html(depth + " ⚡");
    } else if (depth <= 17) {
        $("#depth-counter").html(depth + " 🐇");
    } else {
        $("#depth-counter").html(depth + " 🐢");
    }
});
