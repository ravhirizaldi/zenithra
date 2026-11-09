function getIdentificationRequired(url, verificationToken, repTopIds, approveFunc, identificationCodeFunc, serverErrorFunc) {
    $('html, body').css("cursor", "wait");
    $.ajax({
        type: 'POST',
        url: url,
        data: {
            __RequestVerificationToken: verificationToken,
            repTopIds: repTopIds
        }
    }).done(function (data) {
        // レスポンスがjsonでなく文字列ならセッションタイムアウトページが返却された見なして再読み込みしてログイン画面に遷移させる
        if (typeof data == "string") {
            location.reload();
            return false;
        }

        var required = data["required"];
        if (required) {
            // 本人確認コードダイアログ表示
            identificationCodeFunc.call();
        } else {
            // 承認リクエスト送信
            var state = data["state"];
            approveFunc.call(null, state);
        }
    }).fail(function (jqXHR, status, error) {
        console.log('getIdentificationRequired request failed. status: ' + status + ', error: ' + error);
        serverErrorFunc.call();
    }).always(function () {
        $('html, body').css("cursor", "auto");
    });
}

function identification(url, verificationToken, identificationCode, approveFunc, identificationCodeErrorFunc, serverErrorFunc) {
    $('html, body').css("cursor", "wait");
    $.ajax({
        type: 'POST',
        url: url,
        data: {
            __RequestVerificationToken: verificationToken,
            identificationCode: identificationCode
        }
    }).done(function (data) {
        // レスポンスがjsonでなく文字列ならセッションタイムアウトページが返却された見なして再読み込みしてログイン画面に遷移させる
        if (typeof data == "string") {
            location.reload();
            return false;
        }

        var succeeded = data["succeeded"];
        if (succeeded) {
            // 承認リクエスト送信
            var state = data["state"];
            approveFunc.call(null, state);
        } else {
            // エラーメッセージ表示
            identificationCodeErrorFunc.call();
        }
    }).fail(function (jqXHR, status, error) {
        console.log('identification request failed. status: ' + status + ', error: ' + error);
        serverErrorFunc.call();
    }).always(function () {
        $('html, body').css("cursor", "auto");
    });
}
